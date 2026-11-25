// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! A transaction whose start is cancelled must not reach the pool open.
//!
//! sqlx 0.9's `PgTransactionManager::begin` guards a cancelled `BEGIN` with a
//! rollback, but the guard calls `start_rollback` before the depth it checks
//! has been raised, so at the top level it queues nothing. A request future
//! dropped while its `BEGIN` waits for a reply — a client that disconnects,
//! tower-http's timeout — then returns its connection inside a transaction
//! sqlx no longer knows about. Every later autocommit statement on that
//! connection runs inside it: `authenticate`'s `UPDATE sessions` keeps the
//! session row locked for good, and a `SET LOCAL` outlives its request.
//!
//! The window is one round trip wide. This suite holds it open
//! deterministically: an advisory lock held by a second connection keeps a
//! statement pipelined ahead of the `BEGIN` waiting, so the `BEGIN`'s reply
//! cannot arrive until the test lets it.

use std::future::{Future as _, poll_fn};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll, Waker};

use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection as _, PgConnection};
use uuid::Uuid;

use crate::support::url;

/// Unique to this suite: the dev database is shared with every other test
/// process nextest runs alongside it, and an advisory lock is database-wide.
const LOCK_KEY: i64 = 7_265_012_026;

#[tokio::test]
async fn a_begin_cancelled_before_its_reply_does_not_leave_the_connection_in_a_transaction() {
    let mut holder = PgConnection::connect(&url())
        .await
        .expect("holder connects");
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(LOCK_KEY)
        .execute(&mut holder)
        .await
        .expect("take the advisory lock");

    let armed = Arc::new(AtomicBool::new(false));
    let fired = Arc::new(AtomicBool::new(false));
    let pool = {
        let (armed, fired) = (Arc::clone(&armed), Arc::clone(&fired));
        // One connection, so the probe below is handed the very connection
        // the cancelled request used.
        PgPoolOptions::new()
            .max_connections(1)
            .min_connections(0)
            .before_acquire(move |conn, _meta| {
                let (armed, fired) = (Arc::clone(&armed), Arc::clone(&fired));
                Box::pin(async move {
                    if armed.swap(false, Ordering::SeqCst) {
                        // Sent and abandoned: the connection still owes its
                        // ReadyForQuery, so whatever is queued next — the
                        // BEGIN — waits behind the lock.
                        let mut blocked = Box::pin(
                            sqlx::raw_sql("SELECT pg_advisory_xact_lock(7265012026)")
                                .execute(&mut *conn),
                        );
                        let pending = blocked
                            .as_mut()
                            .poll(&mut Context::from_waker(Waker::noop()))
                            .is_pending();
                        drop(blocked);
                        assert!(pending, "the advisory lock should have held the statement");
                        fired.store(true, Ordering::SeqCst);
                    }
                    Ok(true)
                })
            })
            .connect(&url())
            .await
            .expect("test pool connects")
    };
    // before_acquire runs only on a connection being reused, so make one idle.
    drop(pool.acquire().await.expect("warm the pool"));
    armed.store(true, Ordering::SeqCst);

    let mut request = Box::pin(evp_db::auth::memberships(&pool, Uuid::now_v7()));
    poll_fn(|cx| match request.as_mut().poll(cx) {
        Poll::Ready(result) => panic!("BEGIN completed while the lock held it back: {result:?}"),
        Poll::Pending if fired.load(Ordering::SeqCst) => Poll::Ready(()),
        Poll::Pending => {
            // The acquire may run on another task; keep polling until it has.
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    })
    .await;
    drop(request);

    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(LOCK_KEY)
        .execute(&mut holder)
        .await
        .expect("release the advisory lock");

    let mut conn = pool.acquire().await.expect("the connection comes back");
    sqlx::raw_sql("SELECT set_config('evp.leak_probe', 'outlived its statement', true)")
        .execute(&mut *conn)
        .await
        .expect("set the probe");
    let probe: String =
        sqlx::query_scalar("SELECT coalesce(current_setting('evp.leak_probe', true), '')")
            .fetch_one(&mut *conn)
            .await
            .expect("read the probe");

    assert_eq!(
        probe, "",
        "a SET LOCAL outlived its own statement, so the connection came back from the \
         cancelled request still inside its transaction"
    );
}

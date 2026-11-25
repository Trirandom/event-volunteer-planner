// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

//! Who a schedule email run writes to, and what each person's lines are
//! (docs/04 §Publishing, ADR-0054). The run must be the one the emails page
//! previews: enrolled people with or without shifts, one entry per person
//! across every day in scope, nobody who declined, no cancelled placement.

use crate::support::{at, pool, seed_org};
use evp_db::assignments::{self, NewAssignment};
use evp_db::{catalog, locations, schedule, shifts};
use jiff::Timestamp;
use sqlx::PgConnection;
use uuid::Uuid;

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_day(
    conn: &mut PgConnection,
    org_id: Uuid,
    user_id: Uuid,
    name: &str,
    timezone: &str,
    day: &str,
) -> (Uuid, Uuid) {
    let suffix = Uuid::now_v7().simple().to_string();
    let (event, _operation) = catalog::create_event(
        conn,
        Uuid::now_v7(),
        org_id,
        user_id,
        None,
        name,
        &format!("day-{suffix}"),
        timezone,
        (
            at(&format!("{day}T00:00:00Z")),
            at(&format!("{day}T23:00:00Z")),
        ),
    )
    .await
    .expect("create the event");
    let (zone, _operation) = locations::create(
        conn,
        org_id,
        event.id,
        user_id,
        &locations::NewLocation {
            kind: "zone".to_owned(),
            name: "Bar".to_owned(),
            description: None,
            address: None,
            exact_address: None,
            latitude: None,
            longitude: None,
            min_volunteers: None,
            max_volunteers: None,
            checked_by_default: true,
            adults_only: false,
            parent_id: None,
            sort_order: 0,
            colour: None,
            shift_pattern_id: None,
        },
    )
    .await
    .expect("create the zone");
    (event.id, zone.id)
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_shift(
    conn: &mut PgConnection,
    org_id: Uuid,
    user_id: Uuid,
    (event_id, zone_id): (Uuid, Uuid),
    period: (Timestamp, Timestamp),
) -> Uuid {
    let (shift, _operation) = shifts::create(
        conn,
        org_id,
        event_id,
        user_id,
        &shifts::NewShift {
            location_id: zone_id,
            title: None,
            period,
            required_count: 1,
            max_count: None,
            notes: None,
        },
    )
    .await
    .expect("create the shift");
    shift.id
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn seed_volunteer(
    conn: &mut PgConnection,
    org_id: Uuid,
    display_name: &str,
    first_name: Option<&str>,
    email: Option<&str>,
) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO volunteers (id, org_id, display_name, first_name, email) \
         VALUES ($1, $2, $3, $4, $5::citext)",
    )
    .bind(id)
    .bind(org_id)
    .bind(display_name)
    .bind(first_name)
    .bind(email)
    .execute(&mut *conn)
    .await
    .expect("insert volunteers row");
    id
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn enrol(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    volunteer_id: Uuid,
    status: &str,
) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO participations (id, org_id, event_id, volunteer_id, status) \
         VALUES ($1, $2, $3, $4, $5::participation_status)",
    )
    .bind(id)
    .bind(org_id)
    .bind(event_id)
    .bind(volunteer_id)
    .bind(status)
    .execute(&mut *conn)
    .await
    .expect("insert participations row");
    id
}

#[expect(
    clippy::expect_used,
    reason = "test fixtures — a setup failure must abort the test loudly, not be handled"
)]
async fn place(
    conn: &mut PgConnection,
    org_id: Uuid,
    event_id: Uuid,
    user_id: Uuid,
    shift_id: Uuid,
    participation_id: Uuid,
) -> Uuid {
    let (assignment, _operation) = assignments::create(
        conn,
        org_id,
        event_id,
        user_id,
        &NewAssignment {
            shift_id,
            participation_id,
            post_id: None,
            acknowledged_warnings: Vec::new(),
        },
    )
    .await
    .expect("place")
    .expect("participation exists");
    assignment.id
}

/// Saturday in Paris and Sunday in London, each with one morning shift at
/// "Bar", plus a day in October that no run below covers.
struct Weekend {
    org_id: Uuid,
    user_id: Uuid,
    saturday: (Uuid, Uuid),
    sunday: (Uuid, Uuid),
    elsewhere: (Uuid, Uuid),
    shifts: [Uuid; 3],
}

async fn seed_weekend(conn: &mut PgConnection) -> Weekend {
    let (org_id, user_id) = seed_org(conn).await;
    let saturday = seed_day(
        conn,
        org_id,
        user_id,
        "Saturday",
        "Europe/Paris",
        "2026-09-05",
    )
    .await;
    let sunday = seed_day(
        conn,
        org_id,
        user_id,
        "Sunday",
        "Europe/London",
        "2026-09-06",
    )
    .await;
    let elsewhere = seed_day(conn, org_id, user_id, "Other", "Europe/Paris", "2026-10-01").await;
    let mut shifts = [Uuid::nil(); 3];
    for (slot, (day, date)) in shifts.iter_mut().zip([
        (saturday, "2026-09-05"),
        (sunday, "2026-09-06"),
        (elsewhere, "2026-10-01"),
    ]) {
        *slot = seed_shift(
            conn,
            org_id,
            user_id,
            day,
            (
                at(&format!("{date}T08:00:00Z")),
                at(&format!("{date}T12:00:00Z")),
            ),
        )
        .await;
    }
    Weekend {
        org_id,
        user_id,
        saturday,
        sunday,
        elsewhere,
        shifts,
    }
}

#[tokio::test]
async fn one_entry_per_volunteer_with_every_day_in_scope_and_no_other() {
    let pool = pool().await;
    let mut tx = evp_db::begin(&pool).await.expect("begin");
    let w = seed_weekend(&mut tx).await;
    let aurel = seed_volunteer(
        &mut tx,
        w.org_id,
        "MARCHAND Aurel",
        Some("Aurel"),
        Some("aurel@example.test"),
    )
    .await;
    for (day, shift) in [w.saturday, w.sunday, w.elsewhere]
        .into_iter()
        .zip(w.shifts)
    {
        let participation = enrol(&mut tx, w.org_id, day.0, aurel, "confirmed").await;
        place(&mut tx, w.org_id, day.0, w.user_id, shift, participation).await;
    }

    let run = schedule::run(&mut tx, w.org_id, &[w.saturday.0, w.sunday.0])
        .await
        .expect("load the run");

    assert_eq!(run.len(), 1, "one entry for two enrolments: {run:?}");
    let entry = &run[0];
    assert_eq!(entry.volunteer_id, aurel);
    assert_eq!(entry.first_name.as_deref(), Some("Aurel"));
    assert_eq!(entry.email.as_deref(), Some("aurel@example.test"));
    assert!(entry.notify_email);
    let lines: Vec<(&str, &str, Timestamp)> = entry
        .lines
        .iter()
        .map(|line| (line.mission.as_str(), line.timezone.as_str(), line.start))
        .collect();
    assert_eq!(
        lines,
        vec![
            ("Bar", "Europe/Paris", at("2026-09-05T08:00:00Z")),
            ("Bar", "Europe/London", at("2026-09-06T08:00:00Z")),
        ],
        "both days in scope, chronological, each in its own day's zone"
    );
    assert_eq!(entry.lines[0].location_id, w.saturday.1);
}

#[tokio::test]
async fn a_cancelled_placement_is_no_line_and_a_decline_is_no_recipient() {
    let pool = pool().await;
    let mut tx = evp_db::begin(&pool).await.expect("begin");
    let w = seed_weekend(&mut tx).await;

    let camille = seed_volunteer(&mut tx, w.org_id, "Camille", None, None).await;
    let enrolled = enrol(&mut tx, w.org_id, w.saturday.0, camille, "invited").await;
    let placed = place(
        &mut tx,
        w.org_id,
        w.saturday.0,
        w.user_id,
        w.shifts[0],
        enrolled,
    )
    .await;
    assignments::cancel(&mut tx, w.org_id, w.saturday.0, w.user_id, placed, None)
        .await
        .expect("cancel");
    let dom = seed_volunteer(&mut tx, w.org_id, "Dom", None, Some("dom@example.test")).await;
    enrol(&mut tx, w.org_id, w.sunday.0, dom, "declined").await;

    let run = schedule::run(&mut tx, w.org_id, &[w.saturday.0, w.sunday.0])
        .await
        .expect("load the run");

    assert_eq!(run.len(), 1, "Camille only: {run:?}");
    assert_eq!(run[0].volunteer_id, camille);
    assert!(run[0].lines.is_empty(), "{run:?}");
    assert_eq!(run[0].email, None);
}

#[tokio::test]
async fn an_empty_scope_is_an_empty_run() {
    let pool = pool().await;
    let mut tx = evp_db::begin(&pool).await.expect("begin");
    let (org_id, _user_id) = seed_org(&mut tx).await;
    let run = schedule::run(&mut tx, org_id, &[]).await.expect("load");
    assert!(run.is_empty());
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
} from 'vue-router';

import { queryClient } from '../api/queryClient';
import { fetchSession, sessionQueryKey } from '../api/session';
import HomeView from '../views/HomeView.vue';
import { afterLoginTarget } from './redirect';

declare module 'vue-router' {
  interface RouteMeta {
    /**
     * The route is unreachable without a live session. Declared on the route
     * rather than checked inside the view, so a new authenticated view that
     * forgets the check does not exist — you cannot add a route without
     * deciding this.
     */
    requiresSession?: boolean;
    /**
     * Which section of the plan detail page this route is.
     *
     * The same sections exist under both the festival URL and the event URL,
     * and switching scope keeps the coordinator on the section they were
     * reading (`PlanDetailView.vue`). Declaring it here rather than deriving
     * it from the path means the day strip cannot fall out of step with the
     * routes it links to.
     */
    section?:
      | 'details'
      | 'missions'
      | 'shifts'
      | 'form'
      | 'assignments'
      | 'submissions'
      | 'availability'
      | 'emails';
    /**
     * The route wants the whole window, not the centred reading column.
     *
     * Declared here rather than sniffed from the path in `App.vue` for the
     * same reason `section` is: the shell must not have to know which URLs
     * happen to render a board today. A timeline is measured in hours per
     * screen, and 70 rem of it is a page that shows one afternoon.
     */
    layout?: 'wide';
  }
}

/**
 * The sections of a plan page, once per scope.
 *
 * `/festivals/{id}/…` and `/events/{id}/…` are two entry points into one
 * component, not two pages (see `PlanDetailView.vue`), so their children are
 * one definition used twice — two hand-written copies would differ the first
 * time a section is added.
 *
 * **In the order the rail lists them, and the order a festival is set up in.**
 * Details first because it is the landing section: hours, doors and colour are
 * what a coordinator fixes before anything else, and they are the only section
 * that says something useful about an edition nobody has staffed yet. Then the
 * missions that will be worked, then the shifts they are cut into — the
 * missions page has to come before the board it fills, because an empty board
 * is a board with no rows and nothing to drag. Then the volunteer form, which
 * asks about exactly what the two sections above it laid out — which missions
 * a volunteer could do, on which days — and has to be published before a
 * single submission can arrive. Then the assignments that fill those shifts
 * with people. Submissions last: they arrive from volunteers once the rest
 * exists.
 */
function planSections(scope: 'festival' | 'event'): RouteRecordRaw[] {
  return [
    {
      // Inherits the parent's `layout: 'wide'` rather than narrowing the
      // shell: the rail is part of that layout, and a section that reset it
      // would move the navigation sideways every time a coordinator clicked
      // between the board and this form. The form caps its own measure
      // instead, which is the part that actually needs a reading width.
      path: 'details',
      name: `org-${scope}-details`,
      component: async () => import('../views/PlanDetailsView.vue'),
      meta: { section: 'details' },
    },
    {
      // `/missions` used to be the board, which now lives at `/shifts`. A
      // bookmark on the old path therefore lands on the missions page rather
      // than on a 404, which is the right place to land — it names the same
      // rows — and a redirect would have to claim otherwise.
      path: 'missions',
      name: `org-${scope}-missions`,
      component: async () => import('../views/PlanMissionsView.vue'),
      meta: { section: 'missions' },
    },
    {
      path: 'shifts',
      name: `org-${scope}-shifts`,
      component: async () => import('../views/PlanShiftsView.vue'),
      meta: { section: 'shifts' },
    },
    {
      path: 'form',
      name: `org-${scope}-form`,
      component: async () => import('../views/PlanFormView.vue'),
      meta: { section: 'form' },
    },
    {
      // After the shifts it staffs, and before the submissions that feed it:
      // there is nothing to assign until the board has been cut, and the
      // names in its dropdowns arrive from the section below it.
      path: 'assignments',
      name: `org-${scope}-assignments`,
      component: async () => import('../views/PlanAssignmentsView.vue'),
      meta: { section: 'assignments' },
    },
    {
      path: 'submissions',
      name: `org-${scope}-submissions`,
      component: async () => import('../views/PlanSubmissionsView.vue'),
      meta: { section: 'submissions' },
    },
    {
      // A sub-page of the submissions, not a section of its own: the
      // submissions it lists are the ones that could not join that table yet
      // (docs/08 §6). `section` stays `submissions` so the rail keeps that
      // entry selected, and a day picked on the strip lands back on the list —
      // the queue is the organisation's, not a day's.
      path: 'submissions/review',
      name: `org-${scope}-submissions-review`,
      component: async () => import('../views/PlanSubmissionsReviewView.vue'),
      meta: { section: 'submissions' },
    },
    {
      // Last, because it is the corrective step: the windows it edits arrive
      // through the section above it, and the reason to open it is that a
      // plan already exists and somebody's availability has changed since.
      // Reading it before there are submissions would be reading an empty
      // board.
      path: 'availability',
      name: `org-${scope}-availability`,
      component: async () => import('../views/PlanAvailabilityView.vue'),
      meta: { section: 'availability' },
    },
    {
      // After everything it reads: a schedule email is the plan as it stands,
      // so it is the last thing checked before a roster goes out.
      path: 'emails',
      name: `org-${scope}-emails`,
      component: async () => import('../views/PlanEmailsView.vue'),
      meta: { section: 'emails' },
    },
  ];
}

export const router = createRouter({
  history: createWebHistory('/'),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
    {
      path: '/login',
      name: 'login',
      // Lazy: the login page is reached once per session at most, and keeping
      // it out of the entry chunk is free.
      component: async () => import('../views/LoginView.vue'),
    },
    {
      path: '/admin',
      name: 'admin',
      component: async () => import('../views/AdminView.vue'),
      meta: { requiresSession: true },
    },
    {
      // The deployment operator's page (ADR-0045). No `requiresSession`: its
      // authority is the backoffice key, and the operator of a fresh install
      // may have no account to sign in with. Declared before the `/:orgId`
      // routes so it is matched as itself and never read as an org slug —
      // vue-router ranks a static segment above a param anyway, and the order
      // says so to the next reader.
      path: '/backoffice',
      name: 'backoffice',
      component: async () => import('../views/BackofficeView.vue'),
      meta: { requiresSession: false },
    },
    {
      // `orgId` rather than inferring the org from the session (docs/04 §1):
      // a coordinator who is a member of two organisations must say which one
      // they mean, and a route with no org segment would have to guess.
      path: '/:orgId/events',
      name: 'org-events',
      component: async () => import('../views/EventsView.vue'),
      meta: { requiresSession: true },
    },
    {
      // The festivals index is gone: festivals and events are one list on the
      // events page now (`EventsView.vue`). Kept as a redirect rather than
      // deleted, because the old path is in browser histories and in at least
      // one coordinator's bookmarks, and a 404 there teaches nothing.
      path: '/:orgId/festivals',
      redirect: (to) => ({ name: 'org-events', params: to.params }),
    },
    {
      // A per-org integration setting, not per-event, so it sits beside
      // `/events` rather than under a specific event or festival.
      path: '/:orgId/sms-settings',
      name: 'org-sms-settings',
      component: async () => import('../views/SmsSettingsView.vue'),
      meta: { requiresSession: true },
    },
    {
      // A festival and one of its days are the same page at two scopes
      // (`PlanDetailView.vue`), so both URLs mount the same component with
      // the same sections under it. They stay two URLs because they are two
      // resources on the wire and both are already bookmarked.
      //
      // `requiresSession` on the parent is enough — vue-router merges a
      // matched record's meta across the whole chain, so a child left without
      // its own `meta.requiresSession` still inherits the guard rather than
      // needing the flag copied onto every section.
      path: '/:orgId/festivals/:festivalId',
      name: 'org-festival-detail',
      component: async () => import('../views/PlanDetailView.vue'),
      meta: { requiresSession: true, layout: 'wide' },
      // A function, not a bare `{ name }` object: `redirect` does not inherit
      // `to`'s params on its own, and the details section needs the same
      // `orgId`/`festivalId` this route just matched.
      redirect: (to) => ({ name: 'org-festival-details', params: to.params }),
      children: planSections('festival'),
    },
    {
      path: '/:orgId/events/:eventId',
      name: 'org-event-detail',
      component: async () => import('../views/PlanDetailView.vue'),
      meta: { requiresSession: true, layout: 'wide' },
      redirect: (to) => ({ name: 'org-event-details', params: to.params }),
      children: planSections('event'),
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: async () => import('../views/NotFoundView.vue'),
    },
  ],
});

/**
 * The guard is a convenience, not the enforcement.
 *
 * Authorisation lives in the API and in row-level security (docs/12); a client
 * check only decides what is worth rendering. Treating it as the control would
 * mean anyone who can edit their own JavaScript is an administrator.
 */
router.beforeEach(async (to) => {
  const requiresSession = to.meta.requiresSession === true;
  const isLoginPage = to.name === 'login';

  // Every other route is public and has nothing to decide. The header's own
  // `useSession()` shares this query key, so skipping the await here does not
  // mean the answer is never fetched — it means a public route paints without
  // waiting for it.
  if (!requiresSession && !isLoginPage) {
    return true;
  }

  const session = await queryClient.query({
    queryKey: sessionQueryKey,
    queryFn: async ({ signal }) => fetchSession(signal),
    // `query` resolves from the cache while the answer is fresh and fetches
    // otherwise, so this window is what stops a click between two guarded
    // routes from re-asking. It is short enough that a revoked session is
    // noticed quickly, and the API is the authority regardless: a stale
    // `authenticated` here buys a rendered shell and a 401 on its first
    // request.
    staleTime: 30_000,
  });

  if (requiresSession && session.status !== 'authenticated') {
    // `fullPath`, so query and hash survive the round trip through sign-in.
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  if (isLoginPage && session.status === 'authenticated') {
    return afterLoginTarget(to.query['redirect']);
  }

  return true;
});

/**
 * docs/14 §2 — on route change the new view's heading is focused, so a screen
 * reader is not left announcing the old context. Established here rather than
 * per-view because a view that forgets it is a view nobody notices is broken.
 */
router.afterEach(() => {
  queueMicrotask(() => {
    const heading = document.querySelector('h1');
    if (heading instanceof HTMLElement) {
      heading.setAttribute('tabindex', '-1');
      heading.focus();
    }
  });
});

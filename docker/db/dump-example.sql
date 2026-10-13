-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Tristan Grunert and contributors
--
-- Dumps one festival of one organisation — its events, their missions
-- (locations) and shifts, and the org's volunteers with what they answered,
-- declared and were assigned — as the JSON `evp_domain::example` embeds, so
-- the "load the example" buttons recreate what a coordinator built by hand.
-- Run through `just dump-example <org-slug> [festival-slug]`, not directly.
--
-- Point it only at an org holding mock volunteers: whatever is in it gets
-- committed, and CLAUDE.md forbids committing real volunteer data.
--
-- Every volunteer of the org is dumped, not only those with a participation
-- in this festival: someone who answered the form and ticked nothing is a
-- real case (09 §3), and they have no row tying them to any one festival.
--
-- Run as the superuser because every table here FORCEs row-level security
-- and the org id is not known until `organizations` has been read, which
-- that same policy hides. Read-only: the transaction is never committed.
--
-- Instants are printed in Europe/Paris with their offset: they parse back as
-- the same absolute instants whatever the zone, and a coordinator reading a
-- diff of the file sees the wall-clock times they typed.
--
-- `json` (not `jsonb`) throughout, so keys keep the order written here.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

BEGIN READ ONLY;
SET LOCAL TIME ZONE 'Europe/Paris';

WITH org AS (
    SELECT id FROM organizations WHERE slug = :'org'
),
festival AS (
    SELECT f.*
    FROM festivals f
    JOIN org ON org.id = f.org_id
    WHERE nullif(:'festival', '') IS NULL OR f.slug = :'festival'
    ORDER BY f.created_at DESC
    LIMIT 1
),
-- Zones before their posts, so a post's `parent` always names an earlier
-- index; then the order the board shows them in. `id` breaks ties so two
-- missions sharing a sort_order dump in the same order every time.
location AS (
    SELECT l.*,
           (row_number() OVER (PARTITION BY l.event_id
                               ORDER BY (l.kind = 'post'), l.sort_order, l.name, l.id) - 1)::int AS idx
    FROM locations l
    JOIN events e ON e.id = l.event_id
    JOIN festival ON festival.id = e.festival_id
),
-- The same order the `shifts` array below is written in, so an assignment's
-- `shift` index points at the right element.
shift AS (
    SELECT s.*,
           (row_number() OVER (PARTITION BY s.event_id
                               ORDER BY l.idx, lower(s.period), upper(s.period), s.id) - 1)::int AS idx,
           l.idx AS location_idx
    FROM shifts s
    JOIN location l ON l.id = s.location_id
),
-- One submission per volunteer: the latest applied one, which is what the
-- pool row reflects. Earlier ones it superseded would load as duplicates.
submission AS (
    SELECT DISTINCT ON (s.volunteer_id) s.volunteer_id, s.submitted_at, p.raw
    FROM submissions s
    JOIN org ON org.id = s.org_id
    LEFT JOIN submission_payloads p ON p.submission_id = s.id
    WHERE s.state = 'applied' AND s.volunteer_id IS NOT NULL
    ORDER BY s.volunteer_id, s.submitted_at DESC NULLS LAST, s.id DESC
)
SELECT json_build_object(
    'festival', json_build_object(
        'name', festival.name,
        'slug', festival.slug,
        'timezone', festival.timezone,
        'period', json_build_array(lower(festival.period), upper(festival.period))
    ),
    'events', coalesce((
        SELECT json_agg(json_build_object(
            'name', e.name,
            'slug', e.slug,
            'period', json_build_array(lower(e.period), upper(e.period)),
            'public_period', CASE WHEN e.public_period IS NOT NULL
                                  THEN json_build_array(lower(e.public_period), upper(e.public_period)) END,
            'color', e.color,
            'max_hours_per_day', e.max_hours_per_day::text,
            'min_rest_minutes', e.min_rest_minutes,
            'max_consecutive_days', e.max_consecutive_days,
            'night_starts_at', e.night_starts_at::text,
            'night_ends_at', e.night_ends_at::text,
            'availability_step_minutes', e.availability_step_minutes,
            'locations', coalesce((
                SELECT json_agg(json_build_object(
                    'name', l.name,
                    'parent', parent.idx,
                    'sort_order', l.sort_order,
                    'colour', l.colour,
                    'description', l.description,
                    'address', l.address,
                    'exact_address', l.exact_address,
                    'latitude', l.latitude,
                    'longitude', l.longitude,
                    'min_volunteers', l.min_volunteers,
                    'max_volunteers', l.max_volunteers
                ) ORDER BY l.idx)
                FROM location l
                LEFT JOIN location parent ON parent.id = l.parent_id
                WHERE l.event_id = e.id
            ), '[]'),
            'shifts', coalesce((
                SELECT json_agg(json_build_object(
                    'location', s.location_idx,
                    'period', json_build_array(lower(s.period), upper(s.period)),
                    'title', s.title,
                    'required_count', s.required_count,
                    'max_count', s.max_count,
                    'notes', s.notes
                ) ORDER BY s.idx)
                FROM shift s
                WHERE s.event_id = e.id
            ), '[]')
        ) ORDER BY lower(e.period), e.slug)
        FROM events e
        WHERE e.festival_id = festival.id
    ), '[]'),
    'volunteers', coalesce((
        SELECT json_agg(json_build_object(
            'display_name', v.display_name,
            'first_name', v.first_name,
            'last_name', v.last_name,
            'email', v.email,
            'phone', v.phone,
            'tshirt_size', v.tshirt_size,
            'dietary', v.dietary,
            'notes', v.notes,
            'is_core_team', v.is_core_team,
            'submitted_at', sub.submitted_at,
            -- Stored as `[{question, value}]` by both the example loader and
            -- intake; passed through untouched.
            'answers', coalesce(sub.raw::json, '[]'),
            'participations', coalesce((
                SELECT json_agg(json_build_object(
                    'event', e.slug,
                    'status', p.status,
                    'windows', coalesce((
                        SELECT json_agg(json_build_object(
                            'kind', w.kind,
                            'period', json_build_array(lower(w.period), upper(w.period)),
                            'note', w.note,
                            -- Typed in by a coordinator rather than read off
                            -- a submission: the two provenances may overlap
                            -- each other, so which one it was must survive.
                            'declared', w.declared_by IS NOT NULL
                        ) ORDER BY lower(w.period), upper(w.period), w.id)
                        FROM availability_windows w
                        WHERE w.participation_id = p.id
                    ), '[]'),
                    'assignments', coalesce((
                        SELECT json_agg(json_build_object(
                            'shift', s.idx,
                            'status', a.status,
                            'acknowledged_warnings', a.acknowledged_warnings
                        ) ORDER BY s.idx)
                        FROM assignments a
                        JOIN shift s ON s.id = a.shift_id
                        -- A cancelled assignment is history, not something
                        -- to recreate in a fresh example.
                        WHERE a.participation_id = p.id AND a.status <> 'cancelled'
                    ), '[]')
                ) ORDER BY lower(e.period), e.slug)
                FROM participations p
                JOIN events e ON e.id = p.event_id
                WHERE p.volunteer_id = v.id AND e.festival_id = festival.id
            ), '[]')
        ) ORDER BY sub.submitted_at NULLS LAST, v.display_name, v.id)
        FROM volunteers v
        LEFT JOIN submission sub ON sub.volunteer_id = v.id
        WHERE v.org_id = festival.org_id
    ), '[]')
)
FROM festival;

ROLLBACK;

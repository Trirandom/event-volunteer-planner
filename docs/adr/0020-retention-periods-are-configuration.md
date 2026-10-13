# ADR-0020 — Retention periods are per-organisation configuration, with a default of 18 months and a hard cap

**Status:** Accepted · **Date:** 2026-09-10
**Amended by:** [ADR-0021](0021-retention-tier-follows-table.md) — tier membership
is corrected there; the periods and caps below are unchanged.
**Amended by:** [ADR-0026](0026-retention-scope-is-a-table-registry.md) — adds a
third configurable period on the same pattern, `submission_raw_days` (default 30,
capped at 180), for verbatim form payloads.
**Amends:** [ADR-0018](0018-purpose-based-retention.md) — the tier model stands;
the pool expiry becomes configuration and its default changes from 24 to 18
months. Adds the legal framing that ADR-0018 left implicit.

## Context

[ADR-0018](0018-purpose-based-retention.md) fixed retention periods in the
design: event data purged one month after the event, pool data kept for 24
months from last contact. The 24 was a round number with no reasoning attached.

Two things prompted revisiting it.

**A factual correction.** It was suggested that GDPR imposes a maximum
retention period of about a year where a person has not interacted with the
service. **It does not.** The regulation specifies no numeric period anywhere.
Article 5(1)(e) states the storage-limitation principle — data may be kept "no
longer than is necessary for the purposes for which the personal data are
processed" — and leaves the period to the controller, who must choose it and be
able to justify it.

The numbers that circulate come from national guidance, not the regulation:

- **CNIL**, the French authority, commonly references **around three years from
  the last contact** for prospecting-type data, which is the closest analogue to
  keeping a volunteer's details in order to invite them to a future event.
- The **13-month** figure that resembles "about a year" is CNIL's guidance on
  **cookies and consent validity** — a different regime that does not govern
  database retention.

This matters beyond pedantry: this project is open source, so other operators
will read its documentation and may repeat what it says. A document asserting
"GDPR requires 18 months" would be wrong, and an operator relying on it would
be relying on an invented rule.

**A product observation.** Of roughly three hundred volunteers per event, only
about twenty are people the coordinators actively want back; the rest can
re-fill the form each year at negligible cost to anyone.

## Decision

**Retention periods are per-organisation configuration**, with documented
defaults and a maximum the software will not exceed.

```sql
CREATE TABLE org_retention_policies (
  org_id                    uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  event_data_days           int NOT NULL DEFAULT 30
    CHECK (event_data_days BETWEEN 1 AND 180),
  pool_months_after_contact int NOT NULL DEFAULT 18
    CHECK (pool_months_after_contact BETWEEN 1 AND 36),
  updated_by                uuid REFERENCES users(id),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
```

- **Default pool expiry: 18 months from last contact.** For an annual event, 12
  months expires right around the next edition, so a slipped planning cycle
  silently drops the pool exactly when it is needed. 18 spans edition to
  edition with slack, and remains well inside CNIL's three-year reference.
- **Default event-data purge: 30 days**, unchanged.
- **Hard caps in the schema**, not merely in the UI: 36 months for the pool, 180
  days for event data. An operator cannot configure indefinite retention, and
  the ceiling is enforced by a `CHECK` rather than by a form validation someone
  can bypass through the API.
- **Configurable because this is multi-tenant and open source.** An
  organisation running quarterly events has different needs from a summer
  festival, and hard-coding one association's judgement into everyone's
  deployment is wrong.
- **The documentation never states what the law requires.** It states what this
  software does by default and why, and points the operator at their own
  regulator. That is the honest division: the software provides mechanism and a
  defensible default; the operator owns the justification.

Two supporting refinements:

**The retained record is a contact record, not a profile.** Pool retention
keeps name, email, phone and skills. It does **not** keep dietary requirements,
T-shirt size, meal plan or birthdate — those are event-scoped, change year to
year, and include the most sensitive field in the schema. So even a volunteer
who consents has most of their data deleted at 30 days.

**Over-consent is self-limiting.** Consent is collected by a checkbox on the
form, so it is possible that far more people tick it than the twenty the
coordinators actually want. That is acceptable without further gating, because
the 18-month expiry prunes anyone who is not contacted again — the expiry is
the mitigation. A coordinator may additionally mark and filter a "core team"
subset, and may delete anyone from the pool at any time, but neither is a
precondition for consent to be honoured.

## Alternatives considered

**Keep 24 months, hard-coded.** Rejected: an unjustified number, and
inappropriate to fix on behalf of every deployment.

**12 months.** Tighter and equally defensible, and it was the initial
instinct. Rejected as the *default* on the annual-cycle argument above — the
expiry lands exactly at the moment of need. It remains available as
configuration, and an organisation with a shorter cycle should use it.

**Three years, matching CNIL's prospecting reference.** Rejected as a default:
it is the ceiling of what is defensible, not a target, and it keeps data far
longer than stated to be necessary. Available as configuration, at the cap.

**Require both volunteer consent *and* a coordinator "keep" flag** before
retention. More minimising, and the recommended option when this was discussed.
Not adopted: it means asking three hundred people a question that only affects
twenty, and honouring consent only conditionally makes the question slightly
dishonest. The expiry achieves most of the same pruning without that problem.

**Post-event invitation to selected volunteers instead of a form checkbox.**
The other option discussed, and rejected in favour of the simpler flow: a
checkbox needs no extra email cycle, and silence-means-deletion semantics on an
invitation would drop people who simply did not read their email.

## Consequences

- Every deployment can set periods appropriate to its own event cadence, within
  bounds the software enforces.
- The default is justified by the annual-event cycle rather than by being a
  round number, and the reasoning is written down where the next person will
  find it.
- The documentation is accurate about the law, which matters more for an
  open-source project than for an internal one.
- The retention sweep must read per-organisation configuration rather than a
  constant, and its tests must cover a non-default policy — otherwise the
  configurability is untested and therefore untrue.
- Changing a policy is an audited action: shortening it means the next sweep
  deletes more, which is safe, and lengthening it does **not** resurrect
  anything already deleted. That asymmetry is worth stating in the UI, since it
  is not obvious.

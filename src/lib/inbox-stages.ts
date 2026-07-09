// Per-department ticket workflow stages — ported from the legacy app's
// config/inbox_stages.php. Drives the stage badge shown on the support board.
// `color` is a badge CSS class (defined in the tickets list view).

export interface Stage { label: string; color: string }

export const INBOX_STAGES: Record<string, Record<string, Stage>> = {
  support: {
    awaiting_triage:        { label: 'Awaiting triage',        color: 'badge-primary'  },
    in_progress:            { label: 'In progress',            color: 'badge-active'   },
    onsite_booked:          { label: 'Onsite booked',          color: 'badge-active'   },
    waiting_on_customer:    { label: 'Waiting on customer',    color: 'badge-lead'     },
    waiting_on_third_party: { label: 'Waiting on third party', color: 'badge-lead'     },
    escalated:              { label: 'Escalated',              color: 'badge-danger'   },
    resolved:               { label: 'Resolved',               color: 'badge-resolved' },
    closed:                 { label: 'Closed',                 color: 'badge-inactive' },
  },
  repair_center: {
    not_started:          { label: 'Not started',          color: 'badge-primary'  },
    in_progress:          { label: 'In progress',          color: 'badge-active'   },
    awaiting_parts:       { label: 'Awaiting parts',       color: 'badge-lead'     },
    ready_for_collection: { label: 'Ready for collection', color: 'badge-active'   },
    resolved:             { label: 'Delivered / resolved', color: 'badge-resolved' },
    closed:               { label: 'Closed',               color: 'badge-inactive' },
  },
  comms: {
    new_enquiry:       { label: 'New enquiry',       color: 'badge-primary'  },
    quoted:            { label: 'Quoted',            color: 'badge-lead'     },
    ordered:           { label: 'Ordered',           color: 'badge-active'   },
    awaiting_delivery: { label: 'Awaiting delivery', color: 'badge-lead'     },
    in_progress:       { label: 'In progress',       color: 'badge-active'   },
    resolved:          { label: 'Complete',          color: 'badge-resolved' },
    closed:            { label: 'Closed',            color: 'badge-inactive' },
  },
  sales: {
    new_lead:      { label: 'New lead',      color: 'badge-primary'  },
    in_discussion: { label: 'In discussion', color: 'badge-active'   },
    proposal_sent: { label: 'Proposal sent', color: 'badge-lead'     },
    won:           { label: 'Won',           color: 'badge-resolved' },
    lost:          { label: 'Lost',          color: 'badge-inactive' },
    closed:        { label: 'Closed',        color: 'badge-inactive' },
  },
  quotes: {
    awaiting_triage: { label: 'Awaiting triage', color: 'badge-primary'  },
    in_progress:     { label: 'In progress',     color: 'badge-active'   },
    quote_sent:      { label: 'Quote sent',      color: 'badge-lead'     },
    won:             { label: 'Won',             color: 'badge-resolved' },
    closed:          { label: 'Closed',          color: 'badge-inactive' },
  },
  invoices: {
    awaiting_triage: { label: 'Awaiting triage', color: 'badge-primary'  },
    in_progress:     { label: 'In progress',     color: 'badge-active'   },
    resolved:        { label: 'Resolved',        color: 'badge-resolved' },
    closed:          { label: 'Closed',          color: 'badge-inactive' },
  },
  leads: {
    new_lead:      { label: 'New lead',      color: 'badge-primary'  },
    in_discussion: { label: 'In discussion', color: 'badge-active'   },
    proposal_sent: { label: 'Proposal sent', color: 'badge-lead'     },
    won:           { label: 'Won',           color: 'badge-resolved' },
    lost:          { label: 'Lost',          color: 'badge-inactive' },
    closed:        { label: 'Closed',        color: 'badge-inactive' },
  },
  general: {
    awaiting_triage: { label: 'Awaiting triage', color: 'badge-primary'  },
    in_progress:     { label: 'In progress',     color: 'badge-active'   },
    resolved:        { label: 'Resolved',        color: 'badge-resolved' },
    closed:          { label: 'Closed',          color: 'badge-inactive' },
  },
};

// Resolve a stage badge for a ticket. Returns null when the stage isn't recognised
// (the view then falls back to a plain status badge).
export function stageBadge(department: string | null | undefined, stage: string | null | undefined): Stage | null {
  const dept = (department || 'support');
  const set = INBOX_STAGES[dept] || INBOX_STAGES.support;
  return (stage && set[stage]) ? set[stage] : null;
}

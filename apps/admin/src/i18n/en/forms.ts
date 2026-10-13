// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tristan Grunert and contributors

import type fr from '../fr/forms';

export default {
  labels: {
    kind: {
      shortText: 'Short text',
      longText: 'Long text',
      email: 'Email',
      phone: 'Phone',
      date: 'Date',
      singleChoice: 'Single choice',
      multiChoice: 'Multiple choice',
      boolean: 'Yes / No',
      availability: 'Availability',
      missions: 'Missions',
      consent: 'Consent',
      section: 'Section',
    },
    builtin: {
      firstName: 'First name',
      lastName: 'Last name',
      email: 'Email address',
      phone: 'Phone',
      tshirtSize: 'T-shirt size',
      dietary: 'Dietary requirements',
      notes: 'Remarks',
      availability: 'Availability',
      missions: 'Possible missions',
      processingConsent: 'Consent to processing',
      poolConsent: 'Keeping details for future events',
      commitment: 'Volunteer commitment',
    },
    destination: {
      firstName:
        'Fills in the first name on the volunteer record, used to greet them.',
      lastName: 'Fills in the last name on the volunteer record.',
      email:
        'Fills in the address on the volunteer record; the public link recognises volunteers by it.',
      phone:
        'Fills in the phone number on the volunteer record, used for text messages.',
      tshirtSize: 'Fills in the T-shirt size on the volunteer record.',
      dietary: 'Fills in the dietary requirements on the volunteer record.',
      notes: 'Fills in the remarks on the volunteer record.',
      availability: 'Becomes the availability windows for each event in scope.',
      missions:
        'Becomes each participation’s list of possible missions, consulted when making assignments.',
      processingConsent:
        'Recorded with the submission, along with the privacy notice version.',
      poolConsent:
        'Recorded on the volunteer record; without it, the record is anonymised after the event.',
      commitment:
        'Recorded with the submission: the volunteer confirms they take part unpaid, on the association’s behalf.',
      custom:
        'A question of this form’s own: the answer is kept with the participation, for as long as the event’s data.',
    },
    requiredReason: {
      firstName:
        'Always required: the first name is used to greet the volunteer and to recognise them.',
      email:
        'Always required: on the public link, the address is what identifies the volunteer.',
      processingConsent:
        'Always required: without this consent, the answers cannot be processed.',
      poolConsent:
        'Never required: refusing to have details kept must not stop anyone signing up.',
      commitment:
        'Always required: it is what makes the help given a volunteer commitment on the association’s behalf.',
    },
    dietarySensitive:
      'Always sensitive: dietary requirements can reveal a religion or a health condition.',
    sensitiveEffect:
      'Sensitive answers are left out of exports by default and hidden from zone leads.',
  },

  problems: {
    duplicateTarget: 'This question is already asked further up.',
    duplicateAvailability: 'A form asks for availability only once.',
    duplicateMissions: 'A form asks for possible missions only once.',
    duplicateConsent: 'This consent is already asked for further up.',
    sectionTitleMissing: 'Give this section a title.',
    labelMissing: 'The French label is required.',
    helpMissingFr: 'The help text exists in English but not in French.',
    consentPurposeMissing: 'This consent has no purpose.',
    poolRetentionRequired:
      'Keeping details for future events cannot be required: refusing it must not stop anyone signing up.',
    contactUntargeted:
      'An email address or phone number must fill in the volunteer record.',
    optionsUnexpected: 'This kind of question takes no options.',
    optionsMissing: 'The list of options is missing.',
    optionLabelMissing: 'Every option needs a French label.',
    unscoped:
      'This form covers no event: there are no days or missions to offer.',
    processingConsentMissing:
      'The consent to processing the answers is missing: a form cannot be published without it.',
    commitmentMissing:
      'The volunteer commitment is missing: a form cannot be published without it.',
    firstNameMissing: 'The first name question is missing.',
    emailMissing: 'The email address question is missing.',
    mustBeRequired: 'This question must be required.',
    optionsEmpty: 'Add at least one option.',
    duplicateOption: 'Two options have the same value.',
    missionUnresolved: 'No longer matches any mission: {missions}.',
    labelMissingEn:
      'The form is in English by default: a translation is missing.',
  },

  tags: {
    required: 'Required',
    sensitive: 'Sensitive',
  },

  status: {
    creating: 'Creating…',
  },

  errors: {
    unavailable:
      'The server cannot be reached. Check your connection and try again.',
  },

  page: {
    title: 'Form',
    help: {
      intro:
        'The form is what volunteers fill in: their contact details, their availability for each event and the missions they are interested in. A festival has a single form, covering all of its events.',
      draft:
        'You work on a draft, which you can save as many times as you like. Publishing freezes it: each answer stays tied to the version it answered. To change a published form, create a new version, edit it, then publish it in turn.',
      reorder:
        'To reorder, use the Move up and Move down buttons, or these shortcuts from a question (outside a text field):',
      shortcutUp: 'Alt+↑',
      shortcutDown: 'Alt+↓',
    },
    covered: {
      named:
        '{day} is part of {festival}: the festival’s form covers this day, with its availability and its missions.',
      unnamed:
        '{day} is part of a festival: the festival’s form covers this day, with its availability and its missions.',
      open: 'Open the festival’s form',
    },
    formsFailed: 'The forms could not be loaded.',
    picker: 'Form',
    versions: {
      heading: 'Versions',
      number: 'v{version}',
      draft: 'draft',
      publishedOn: 'published {date}',
      live: 'live',
      questionCount: '· {count, plural, one {# question} other {# questions}}',
    },
    versionFailed: 'This version could not be loaded.',
    toolbar: {
      label: 'Draft',
      status: 'Draft v{version} ·',
      unsaved: 'Unsaved changes',
      allSaved: 'Everything is saved',
      discard: 'Discard changes',
      publish: 'Publish',
      publishHint: 'Save first: it is the saved version that gets published.',
    },
    frozen: {
      title: 'Version {version}, published {date}.',
      live: 'This is the version volunteers fill in.',
      explanation:
        'A published version is frozen: the answers already received stay readable exactly as they were given.',
      createVersion: 'Create a new version',
      openDraft: 'Open draft v{version}',
    },
    summary: {
      heading:
        '{count, plural, one {One thing to fix} other {# things to fix}}',
      blocking: '— {count, plural, one {one blocks} other {# block}} saving',
      question: 'Question {position}',
      form: 'Form',
      separator: ':',
    },
    tabs: {
      label: 'View',
      questions: 'Questions',
      preview: 'Preview',
    },
    notice: {
      label: 'Privacy notice version',
      hint: 'Recorded with each submission, so it is known which notice the volunteer accepted. Optional.',
    },
    palette: {
      heading: 'Add a question',
      builtin: 'Built-in questions',
      allAdded: 'All built-in questions are already on the form.',
      custom: 'Custom questions',
      section: 'Section (title and text)',
    },
    publishDialog: {
      title: 'Publish version {version}?',
      confirm: 'Publish',
      busy: 'Publishing…',
      body: 'Once published, this version becomes the one volunteers fill in.',
      frozen:
        'It is frozen: no question can be changed, added or removed any more.',
      why: 'That is what guarantees each answer stays readable exactly as it was given. To change the form afterwards, you will create a new version.',
      risk: 'The server may refuse to publish it:',
    },
    leaveDialog: {
      title: 'Leave without saving?',
      confirm: 'Discard changes',
      busy: '…',
      stay: 'Stay on this page',
      body: 'The draft has unsaved changes. They will be lost if you leave this page now.',
    },
    toast: {
      saved: 'Draft saved.',
      saveConflict:
        'This draft was changed elsewhere, or published, since you opened it: nothing was saved. Your changes are still on screen.',
      reload: 'Reload the saved version (discards your changes)',
      saveRefused:
        '{count, plural, =0 {The server refused to save this draft.} one {The server refused to save this draft: one problem, shown above and on the question concerned.} other {The server refused to save this draft: # problems, shown above and on the questions concerned.}}',
      publishRefused:
        '{count, plural, =0 {The server refused to publish this draft.} one {The server refused to publish this draft: one problem, shown above and on the question concerned.} other {The server refused to publish this draft: # problems, shown above and on the questions concerned.}}',
      published:
        'Version {version} published: it is now the one volunteers fill in. It can no longer be changed; to change a question, create a new version.',
      publishConflict:
        'This draft changed after it was loaded: it has been reloaded. Read it through again before publishing.',
      versionCreated: 'Draft v{version} created from the live version.',
      draftExists: 'A draft already exists: it is open below.',
      formCreated:
        'Form created. Here is its first draft: read through the questions, then publish it.',
    },
    announce: {
      moved:
        '{named, select, yes {“{label}”} other {The question}} is now in position {position} of {total}.',
      removed:
        '{named, select, yes {“{label}”} other {The question}} has been removed from the draft.',
      added:
        '{named, select, yes {“{label}”} other {The question}} has been added at the end of the form.',
      discarded: 'Changes discarded.',
    },
  },

  card: {
    untitled: '(no label)',
    origin: '{builtin, select, yes {Built-in} other {Custom}}',
    originLabel:
      '{builtin, select, yes {Built-in} other {Custom}}: {destination}',
    problemCount: '{count, plural, one {# problem} other {# problems}}',
    moveUp: 'Move “{title}” up',
    moveUpHint: 'Move up (Alt+↑)',
    moveDown: 'Move “{title}” down',
    moveDownHint: 'Move down (Alt+↓)',
    remove: 'Remove “{title}”',
    field:
      '{field, select, title {Title} text {Text} help {Help} other {Label}} ({lang})',
    optional: 'optional',
    options: 'Options',
    optionFr: 'Option {number} (fr)',
    optionEn: '(en)',
    valueFixed: 'Saved value: it no longer changes.',
    valueDerived: 'Value derived from the label.',
    removeOption: 'Remove option {number}',
    removeOptionNamed: 'Remove option {number} “{label}”',
    addOption: 'Add an option',
    tshirtSizes: 'Fixed sizes: {sizes}.',
    availabilityHint:
      'One group per event in scope, with a row per day: volunteers give their exact time ranges there.',
    booleanHint:
      'When required, it shows as two buttons, “Yes” / “No”, with neither preselected; when optional, as a single checkbox.',
  },

  missions: {
    legend: 'Missions offered',
    loadFailed:
      'The missions in scope could not be loaded: only those already offered are shown.',
    none: 'No missions declared yet. Add them on the Missions page: they will appear here, ready to tick.',
    notOffered: 'Not offered',
    unresolved: 'No longer matches any mission',
    labelFr: 'Label (fr)',
    labelEn: 'Label (en)',
    adultsOnly: '18+',
    notPreTicked: 'Not ticked by default',
    flagsHint:
      'Missions come pre-ticked for the volunteer, except those tagged "Not ticked by default" or "18+". Both are set on the Missions page, on each zone’s card.',
  },

  settings: {
    title: 'Form settings',
    name: 'Name',
    defaultLocale: 'Default language',
    publicLink: 'Public link:',
    open: 'Public link open to new sign-ups',
    openHint:
      'When closed, the public link refuses new sign-ups; the personal links sent to known volunteers keep working.',
    noLiveVersion:
      'No version is published yet: the link will show nothing until there is one.',
    saved: 'Settings saved.',
    conflict:
      'These settings were changed elsewhere in the meantime. Check them, then save again.',
    save: 'Save settings',
  },

  newForm: {
    lead: 'No form yet. Create it: it starts with the questions every form asks — first name, last name, email, phone, availability, possible missions and consent — which you can then reword, add to and reorder.',
    name: 'Name',
    slug: 'Public link',
    slugHint:
      'Lowercase letters, digits and hyphens. This is the address volunteers will type: it is hard to change once it has been shared.',
    slugTaken: 'This link is already used by another form. Choose another one.',
    create: 'Create the form',
  },

  preview: {
    locale: 'Preview language',
  },
} satisfies typeof fr;

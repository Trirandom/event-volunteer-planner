-- The first-party form's two vocabularies (docs/03 §3.1), declared in a
-- migration of their own because they are what a reviewer has to agree with
-- before the tables in the next migration mean anything.
--
-- Eleven answerable kinds plus 'section', which is layout and takes no answer
-- (docs/09 §1). 'missions' is ADR-0036. A form builder stops here
-- deliberately: no branching, no page logic.
CREATE TYPE form_question_kind AS ENUM ('short_text', 'email', 'phone', 'date',
                                        'single_choice', 'multi_choice', 'boolean',
                                        'long_text', 'availability', 'missions',
                                        'consent', 'section');

-- What a consent answer is consent *for*. Two purposes, two lawful bases, two
-- retention consequences, and only the first may be required (ADR-0025).
CREATE TYPE consent_purpose AS ENUM ('processing', 'pool_retention');

# Decision log

The decisions that shaped this system, each with what it was chosen over and why. A decision is
recorded here when it was made, and again when it was changed, so the reversals are part of the
record. The design documents (`docs/01` to `09`) describe the system; this file explains why it
is that way.

- [The ones that matter most](#the-ones-that-matter-most)
- [Extraction](#extraction)
- [Models and providers](#models-and-providers)
- [Ground truth and evals](#ground-truth-and-evals)
- [Credit profile and decision engine](#credit-profile-and-decision-engine)
- [Policy defaults](#policy-defaults)
- [Workflow and clarification](#workflow-and-clarification)
- [WhatsApp channel](#whatsapp-channel)
- [Platform: API, data and queue](#platform-api-data-and-queue)
- [Backoffice](#backoffice)
- [Security and observability](#security-and-observability)
- [Deployment and CI](#deployment-and-ci)
- [Decisions that were reversed](#decisions-that-were-reversed)

## The ones that matter most

| Decision | Why |
|---|---|
| **No model takes part in the credit decision.** A fixed feature catalogue, a JSON policy per lender and a pure function `evaluate(policy, profile)` | A credit decision has to be explained and repeated. A model deciding cannot be audited, and the text of the document could steer it |
| **The ground truth does not come from the model being measured.** A deterministic parser per bank reads the text layer, and the bank's own arithmetic arbitrates | Ground truth taken from the system's output measures the model's agreement with itself |
| **Gemini 3.8 Flash extracts; Claude is the emergency path** | Same rows as Opus on the test documents at about a fifth of the cost, then confirmed on all nine documents against the ground truth |
| **Every extraction call on a document shares one output schema** | The schema is part of the cached prompt prefix. With a schema per pass, the second pass paid to write the whole document to the cache again |
| **A value that is not verified does not score** | A feature that is unverified, in conflict or below the confidence floor adds no points, so an invented number cannot raise a credit line |
| **The supplier is asked only when the answer can change the result** | A question that cannot move the status or the band costs the supplier time and buys nothing |
| **In `evaluate`, the document classifier labels and never blocks** | The evaluation runs on statements from banks the system has not seen. A false negative would lose a document that is being measured |
| **Row-level security is forced on every business table** | In a multi-tenant system with financial data, one lender seeing another's data is the worst possible incident |

## Extraction

| Decision | Chosen over | Why |
|---|---|---|
| One output schema and one system prompt for every call on a document (summary, transaction blocks, per-page retry, double read). Only the final instruction changes | A schema per pass; JSON with no schema | Measured in a spike: with different schemas the second pass re-wrote the 11K-token document to the cache instead of reading it. Dropping the schema would give up guaranteed valid JSON, the first layer against invented values |
| The schema the model sees is not the canonical contract; code translates between them. One nullable union, cited values as a single `{ field, value, page, snippet }` type, amounts as printed text | Splitting the schema across smaller calls; validating free JSON by hand | The API rejected the first schema twice: it allows 16 parameters with union types and the contract had 64. Splitting would have broken the shared-schema cache |
| Periods are extracted as the bank prints them; the profile counts the months | Splitting a long period into calendar months with computed cut-off balances | One development statement prints a single period of about three months with one opening and one closing balance. Monthly balances would be calculated values presented as extracted, with nothing on the page to verify them against |
| The fiscal receipt (CFDI) printed inside the statement is part of the contract and is read in the first pass. Digital seals and the full original chain are never transcribed: only whether they are present and whether they look truncated | Ignoring it; a separate call with its own schema | Eight of nine development statements carry it. It gives a hard identifier, the holder's full tax id (which the header often masks) and the tax regime. A separate call would break the cache and pay for another read |
| Transfers between an account and its own sub-accounts are flagged `internal_transfer`, and the reconciliation accounts for consolidated summaries | Treating each sub-account as an account; extracting the sub-account detail sections too | The bank prints no opening or closing balance per sub-account, so none would reconcile, and the detail sections duplicate the transfers |
| What the PDF is as an object (printed pagination, repeated or rotated pages, several statements in one file) is checked in pure functions outside the model | Asking the model | Free, deterministic and testable with synthetic PDFs, with no change to the prompts or the schema, so recorded responses stay valid |
| Tampering signals and missing pages become profile features that the engine reads | Leaving them in the extraction report; adding them to the account's red flags | The extraction already detected white text addressed to the system and a fiscal receipt that did not match, but none of it reached the engine: a document known to be altered could still qualify. Red flags describe the account's cash flow, not the document |
| The holder's address is read and stored, and requested only when the lender's policy requires it | Always asking; not reading it | Most statements print it next to the name. A field the policy does not use is not worth a question to the supplier |
| The contract version rises with each addition and the previous version stays readable | Migrating stored extractions | A stored extraction is immutable; an older one reads with the new field as "not read" |

## Models and providers

| Decision | Chosen over | Why |
|---|---|---|
| `gemini-3.8-flash` is the extraction model, behind the same port, prompts, schema and verification as before. The emergency path depends on the failure: a provider failure or a quality failure (invalid output twice, or an imbalance the targeted retry cannot resolve) escalates to Claude Opus. A second Gemini model is planned for quality failures once its price and limits are verified | Keeping Opus as default; Sonnet as default | On the two test documents Gemini returned the same rows as Opus (161 of 161 on the longer one) at about a fifth of the cost. Sonnet cost the same as Opus and invented a duplicated charge on one document. The switch was conditional on the phase 3 evals over all nine documents, and they confirmed it |
| A second provider enters as an explicit experiment first, routed by model prefix inside the same adapter. Provider-specific options go only to their provider | A separate adapter outside the orchestration layer; not integrating it | The comparison had to use the same prompt, schema and verification to mean anything |
| The extraction router chooses reasoning effort from page count and complexity signals; it does not choose a different model | Adding a third pinned model for simple documents | The list of pinned models had no third one, and adding it meant one more version to pin and evaluate |
| Classification goes through one `Classifier` interface: Jev when its key is present, Haiku otherwise, and the report says which one ran. Deterministic rules go first; the model sees only what the rules do not resolve | Haiku alone; rules alone | Haiku's confidence is nominal (measured in a spike), and classification needs a confidence that means something. Jev returns calibrated probabilities but is a third provider that was on a waiting list when the build started, so it cannot be a hard dependency |
| Haiku interprets free-text replies on WhatsApp into an intent and a value. Fields with a format are read by a rule first | More rules; letting a model decide the answer | Numbers and dates written in words are an endless list for rules. A model deciding would break a standing rule: the supplier's text never authorizes anything and is never guessed |
| Model prices are checked against the provider's official page before any cost is reported | Quoting from memory | A cost figure in a deliverable has to be traceable |

## Ground truth and evals

| Decision | Chosen over | Why |
|---|---|---|
| The ground truth is built without the extraction model. A parser per bank reads the text layer and builds every row, not a sample. Each value records where it came from: text layer, bank arithmetic or visual review | Using the system's output once it reconciles; waiting for a person to review more than 310 pages | With the bank's arithmetic as arbiter (running balance, global reconciliation, printed totals and counts) the full ledger costs the same as a sample and measures omissions for real |
| The ground truth lives outside the repository; the repository holds only a manifest with no personal data. CI restores what it needs from private storage and never calls a model | Versioning the ground truth next to the evals | It contains real financial data |
| No prompt or model change merges if it drops a bank below its eval threshold. A prompt version is immutable once measured | Reviewing prompt changes by reading them | Extraction accuracy is the measured metric, and a prompt change is a hypothesis about it |
| An analyst's correction is stored as an immutable pair (value read, correct value, page) apart from the extraction, over a closed set of targets, and the request is re-decided without calling a model | Editing the stored extraction; free-form pointers into the JSON | The extraction stays as evidence of what the model read, and the pairs become eval data |

## Credit profile and decision engine

| Decision | Chosen over | Why |
|---|---|---|
| A fixed feature catalogue fixes the type and source of every feature. The policy is rejected at parse time if an operator does not fit a feature's type. The engine is pure and returns the full diagnosis and the counterfactuals | Free-form rules per lender; a model that decides | Free rules can refer to anything and cannot be validated. See the first row of this document for the model |
| Gate precedence is `not_qualified`, then `human_review`, then `needs_clarification`. Everything that can be asked is gathered into one round | Asking as each gate fails | One conversation with the supplier, not several |
| A dimension whose feature is unverified, in conflict or below the confidence floor scores nothing; a cap on a doubtful feature still applies | Using the value with a penalty | Doubt can lower a result but never raise it |
| Transactions are classified by deterministic rules with a hand-set confidence per rule, and `loan_payment` is its own class | Classifying everything with a model | Rules are free and repeatable, and the model is kept for what they cannot resolve. Debt service has to be visible to measure capacity |
| A counterfactual must change the status or the credit line to be shown | Comparing score bands | The engine was offering a step that moved the supplier "from qualified with limit to qualified with limit". Status and line are the only things a supplier can notice |
| With no requested amount, the verdict is given at the maximum line the policy approves, and the reason says so | Requiring an amount; returning a profile with no verdict | The assignment asks to tell the supplier whether they qualify. It does not ask the supplier to name an amount first |
| The reasons name the actual cause, and a prose explanation is written for the analyst | Listing every dimension that scored nothing | A real statement produced "no data" three times and a score of zero, which explained nothing |
| A fiscal receipt issued to the generic tax id gives no tax regime | Reading the regime from it | The generic id identifies nobody |
| Business "today" is the Mexico City calendar. Instants are stored in UTC and shown in the viewer's time zone | UTC everywhere | A request processed at 22:08 local time was dated the following day, which shifts the age of the document |

## Policy defaults

| Decision | Chosen over | Why |
|---|---|---|
| The holder's identity is checked with name and tax id only; the bank account number is extracted but does not count. A tax id printed without its check characters is compared by its root, and the root alone is not enough | Requiring all three to match | Real statements print the tax id in a shortened form, and suppliers were being asked for data that added nothing |
| Identity is computed and shown, but it does not decide the credit | An identity gate in the base policy | With a statement whose holder is redacted, the gate stopped requests over data the supplier had already given at registration |
| The age of the statement does not decide by default in `evaluate`; `--policy base` restores the 90-day gate and `--as-of` fixes the calculation date. In full mode the maximum age is a setting of each lender | Keeping the gate and documenting the flag; inventing a calculation date per document | Evaluators run the command on PDFs of unknown date. With the gate on, every request would pause on a question |
| The policy says how many months are evaluated: one, or three in a row | A fixed cap for less than three months of history; scaling the line by months | Development statements cover one month and the evaluation ones probably do too. With a fixed cap almost nobody could reach `qualified`, however healthy the profile |

## Workflow and clarification

| Decision | Chosen over | Why |
|---|---|---|
| Mastra orchestrates the workflow. The provider SDK called directly inside a step is the escape hatch when Mastra hides something that has to be measured | The provider SDK with a hand-written state machine | The problem is a deterministic pipeline with one pause that can last days. Persisted suspend and resume, structured output and tracing would otherwise be written by hand. Two spikes checked that prompt caching, structured output and resuming across processes survive the abstraction |
| Standalone mode keeps its state in the workflow snapshot, so a paused request resumes in a later invocation with `--answers` | Keeping state in the process | The evaluation runs with no infrastructure and still has to pause and resume |
| One `ClarificationChannel` interface with three adapters: console and file, WhatsApp, email | Channel-specific logic in the workflow | The evaluation runs with no infrastructure and full mode with real channels; the workflow should not know which |
| WhatsApp runs on Baileys behind a transport interface | The WhatsApp Cloud API | The official API requires business onboarding and approved templates, out of reach for a worksample. The interface keeps the swap contained |
| One question at a time, with numbered options. Answers are validated, never guessed | Sending every question at once; free interpretation | A wrong reading of a reply changes a credit decision |
| Besides doubtful deposits, the supplier can be asked about doubtful charges, the main client, the use of the account and the currency | Asking about deposits only | In a real test, what had been classified as debt service was 96 % of income and nobody had asked whether that was right |
| Before evaluating, the bot sends a summary to confirm, accepts several answers in one message, and allows a second round | Evaluating on the last answer | Suppliers answered everything in one message, and a mistyped option could not be corrected |
| `exactOptionalPropertyTypes` is off only in the packages that compose Mastra workflows | Off everywhere; casting each sub-workflow | The casts would hide real errors exactly where types matter most, at step inputs and outputs |

## WhatsApp channel

| Decision | Chosen over | Why |
|---|---|---|
| A phone number is not an identity. A message goes only to the destination copied from a verified link; the channel adapter does not accept recipients | Replying to whoever writes | A number must never see another supplier's data |
| The lender links its number by scanning a QR in the backoffice. The session state, the current QR with its expiry and a heartbeat live in a table | The QR in the process's terminal; the API calling the WhatsApp process | In production there is no terminal and the QR would end up in the logs. A direct call would be one more exposed service to secure |
| Statements can arrive as PDF documents in one-to-one chats, up to 40 MB. The WhatsApp process only relays; the worker stores the file and opens the request | Keeping intake API-only; letting the WhatsApp process write to storage | Suppliers already talk on that chat. The WhatsApp process keeps a role with no access to storage or business tables |
| Any number can register itself by chat, switched by a flag that is on by default. The conversation asks for the contact's name and the amount first, then the statement | Registering each number by hand through the API | On a fresh installation there are no suppliers, so the bot could only answer that there was nothing pending |
| The supplier is told the verdict on the same chat. "Not qualified" comes with a short reason built from fixed rules, with no figures and no model | A generic "contact your lender" | The assignment asks to tell the supplier whether they qualify, and an outcome with no reason reads as a failure of the system |
| When a request fails, the supplier and the analyst are told why | A generic "we could not read your statement" | In the first real test a credit-card statement was correctly recognised and rejected, and nobody was told the reason |
| In full mode, a document that is confidently not a bank statement is not extracted | Extracting everything | Extraction costs money, and the confidence threshold (0.9) keeps false negatives out |
| Discarding a document in human review notifies the supplier. The API queues the notice and the worker writes it | Letting the API write to the outbound table | That table belongs to the worker by database permission, and the supplier was left waiting for an answer that never came |

## Platform: API, data and queue

| Decision | Chosen over | Why |
|---|---|---|
| Express 5 with Zod on every input. Routes are a thin adapter over shared operations | Hono | The role asks for Express. Express 5 handles async errors natively, and the thin adapter keeps the framework replaceable |
| The API never runs a workflow. It stores, deduplicates by document hash within the lender, and enqueues | Processing inside the request | Extracting a long PDF takes minutes |
| The PDF does not pass through the API; it goes by signed URL with an expiry. Validation errors return the path of the field, never its value | Multipart upload through the API | Keeps large files and personal data out of the request path and out of error messages |
| Postgres 17 with Drizzle. Row-level security is enabled and forced on every table through one tenant policy. Each process has a minimal role, and a test fails if a new table has no policy | Prisma; isolation in application code | Drizzle keeps policies in the schema. Forced RLS holds even when application code forgets a filter |
| pg-boss on the same Postgres. Idempotency by document hash plus prompt version, three retries with backoff, a dead-letter queue, resume ahead of new work, and a semaphore towards the model providers | Supabase Queues with Edge Functions; a separate broker | An Edge Function's time limit is too short for an extraction. A broker is another system to run for a two-person team. A test showed that only the `exclusive` queue policy actually deduplicates |
| End-to-end scenarios are a YAML catalogue with two modes: unit (no model, no database, synthetic statements) and full (the real API, queue, worker and WhatsApp relay, with only the outside world simulated) | Manual tests with real documents | The cases that matter cross the whole system, and real documents make them expensive and unrepeatable |
| Local full mode runs a trimmed Supabase stack from the repository's own compose file, and the whole stack starts with one command | The Supabase CLI | The CLI is one more tool to install and pin, starts about twelve containers and chooses the versions itself |
| A first-run wizard creates the lender, its administrator and the WhatsApp link from the browser | Terminal commands | Someone opening the backoffice on an empty system had nobody to ask for an access link |

## Backoffice

| Decision | Chosen over | Why |
|---|---|---|
| React 19 with Vite, static. One role and several users per lender | Next.js; fine-grained roles | Server rendering buys nothing for an internal tool behind a login, and fine roles are complexity nobody asked for at this scale |
| The browser talks only to its own API surface, which shares the business operations with the integration API. The lender comes from the session, never from a parameter | The browser talking to the database or to Supabase | An action has the same effect and leaves the same audit row whichever way it came in |
| Login is a link by email through Supabase Auth. The lender id is put in the token by a database hook that first strips any value sent by the client | A token minted by a command-line tool | A non-technical user has to be able to get in without a terminal |
| The session renews itself. The refresh token lives in a second cookie, encrypted and `HttpOnly` | Keeping it in browser storage; a sessions table | Anything in browser storage is readable by any script on the page, so one XSS would take a session that renews itself |
| Prompts are stored in the database with immutable versions and can be edited from the backoffice. They are global, not per lender. A version created there has no evals and is marked as such | Prompts per lender; prompts only in files | Extraction is the same task for every lender, and each extra set of prompts is one more to measure. The files remain the source for the code, the evals and standalone mode |
| Deleting a supplier runs in one transaction through a reviewed database function granted to a single role | A script against the database | It was being done by hand, and it has to respect tenant isolation |
| An analyst can evaluate a statement from the supplier's page | The integration API as the only entry | A supplier created in the backoffice has no verified WhatsApp |
| The timeline of a request is rebuilt on demand from tables that already exist | Storing timeline events | More detail for the analyst with no new data to keep |

## Security and observability

| Decision | Chosen over | Why |
|---|---|---|
| OWASP ASVS 5.0 level 2 is the target. What is cheap and high-value is built; the rest is written down as a plan | Full compliance; nothing formal | Full compliance does not fit a worksample, and nothing formal is unacceptable for financial data |
| Built: forced RLS with an isolation test, minimal roles per process, verified WhatsApp links, errors without values, logs without personal data, statement data outside the repository, an injection eval with adversarial PDFs, pinned dependencies with a minimum release age, and gitleaks and osv-scanner in CI with actions pinned by SHA | | These are the controls that fail silently when they are missing |
| Tracing goes from the workflow to Langfuse, optional by environment variable. Logs carry ids and counts, never document values | Braintrust; Promptfoo | Open source and OpenTelemetry-based. Braintrust was ruled out on cost and Promptfoo after its acquisition |
| Every exchange with a model is stored raw in its own table, with the prompt version, the outcome and the raw output when it was unusable. The PDF is referenced by hash, not copied | Reproducing a failure to see it | When a request failed, only the cost record and a short reason were left |

## Deployment and CI

| Decision | Chosen over | Why |
|---|---|---|
| The production plan is Cloud Run for the API, the worker and WhatsApp from one image, managed Supabase, and the backoffice on Vercel | Kubernetes; Vercel for the API | Three long-lived processes, a static frontend and a two-person team with nobody to operate a cluster. The worker does not fit in functions |
| The production deploy workflow runs only by hand, per environment, with federated identity and no service-account keys | Deploying on every push to `main`; a JSON key in a secret | An automatic deploy would publish and migrate without anyone asking, and a migration cannot be undone. A stored key is a long-lived credential |
| The live demo runs on Railway with managed Supabase | The Cloud Run pipeline | A non-technical person has to log in with the email link, which needs Supabase Auth, and the Cloud Run pipeline needs a cloud project to exist first |
| Access links are sent through Resend as the SMTP of Supabase Auth | New code for transactional email | The local mail catcher delivers nothing to a real inbox, and this needs no code |

## Decisions that were reversed

Changing a decision is not a failure of the first one; hiding the change would be.

| First decision | What replaced it | What changed the answer |
|---|---|---|
| Extract with Claude Opus | Extract with Gemini 3.8 Flash, Claude as emergency | A measured comparison on two documents, then the evals on all nine |
| Ground truth from "initial extraction, reconciliation, manual review" | Ground truth from a parser, with no model | Seeing that the first plan was circular |
| An identity gate in the base policy, with three fields | Identity shown but not deciding, checked with two fields | Real statements with shortened tax ids and redacted holders |
| A 90-day gate on the age of the statement | A setting per lender; off by default in `evaluate` | Evaluation documents of unknown date |
| A cap for less than three months of history | The policy chooses one month or three in a row | Single-month statements could never reach the best result |
| WhatsApp registration asks for company name and tax id first | Contact name and amount first, then the statement, after an intermediate version that started with the statement | Testing the conversation with real statements |
| A session that lasted as long as the access token, one hour | A session that renews itself | Analysts were logged out in the middle of the working day |
| The development loop held by instructions and review | The same loop enforced by agents, skills and hooks ([`harness.md`](harness.md)) | The one privacy slip of the build happened where a rule was written but not enforced |

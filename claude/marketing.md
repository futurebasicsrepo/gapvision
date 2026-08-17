# Marketing — the assets, the channels, and what I can actually run

**17 August 2026.** Kyle's brief: *build it out like you would a new AI company
where most outreach and digital marketing is handled by you.* So this document
is two things — the design of the Console tab, and an honest inventory of what
"handled by you" can mean today, including the parts that are not obvious.

The rule the rest of Console keeps applies here hardest, because marketing is
the discipline most willing to report a number it cannot support: **unknown
never renders as a pass.** An asset that might not be deployed says so. A
channel nobody has connected says so. An automation that is possible but not
running says *possible*, not *running*.

## The tab

One rail item, four cards, in the order a person actually needs them.

**Assets.** Everything sendable, with where it lives and whether it is
genuinely reachable. The two decks and the leave-behind PDF are checked live
with a `HEAD` against the sales origin — an asset that 404s is worse than one
that is missing, because the missing one does not get sent to a merchant.
Repo-resident artwork (plates, the employee one-pager, brand tokens) is listed
as what it is: in the repo, generated on demand, not a URL.

**Channels.** Where outreach can happen, and whether it is wired. Today almost
nothing is, and the card says so plainly rather than showing a row of zeroes.
A zero means "we measured none"; blank means "we cannot see", and those are
different sentences.

**What I can run.** The section below, rendered in Console so it is where the
work happens rather than in a file nobody opens. Each row says what it needs
before it works.

**Learnings.** `claude/marketing-learnings.md`, in the repo, rendered here.
Deliberately not a database and deliberately not localStorage: a learning is
worth exactly as much as its durability, and the two failure modes are a note
lost with a browser profile and a note nobody can review. Git fixes both — it
is versioned, it survives a laptop, and a wrong entry can be corrected with the
correction visible.

## What I can actually run

Grouped by what it costs you to say yes. Everything in the first group works
right now with no setup; everything after it names its blocker.

### Available now, no setup

| Capability | What it means in practice |
|---|---|
| **Research** | Web search and fetch. Prospect and competitor research, pricing teardowns, "who else sells to specialty retail ops", reading a merchant's own site before you write to them. |
| **Writing, in the brand's voice** | The voice is already specified (`packages/brand`), and I have been writing in it all session. Outbound sequences, landing copy, the follow-up that goes out after a deck is opened. |
| **Asset generation** | The plate generator and the one-pager are scripts in this repo. New zones, new stores, a variant for a different vertical — that is a command, not a design cycle. |
| **Site and deck work** | The decks are plain HTML I can edit and deploy. A vertical-specific deck (hospitality, field service) is a third folder, which is the exact reason it was built that way. |
| **Scheduled work** | I can wake myself on a schedule. A Monday digest of deck opens, a nudge when a gated link has been open for three days with no reply, a weekly check that the sales site is still up. |
| **Deploy and watch** | Vercel deploys, build logs, runtime logs. I caught a green-but-broken deploy this way today; the same read applies to a landing page that silently stops rendering. |

### One decision away

| Capability | What it needs from you |
|---|---|
| **Sending email** | The Gmail connector is live in this session, so I can draft *and send* from your account. I have not sent anything and will not without you saying so per campaign — outbound from a founder's address is irreversible and reputational. My recommendation: I draft, you read the first ten, then you decide whether to widen that. |
| **Calendar** | Booking demos directly into your calendar once a lead replies. Same consent question, lower stakes. |
| **Real merchant proof** | The Shopify connector reaches a real store. A demo store seeded with plausible catalogue and traffic makes every deck screenshot true rather than mocked — and "true rather than mocked" is the whole argument of the known-edges slide. |
| **Ad and analytics reporting** | Supermetrics is connected and reaches 150+ sources, but only ones **you** have authorised. Connect Google Analytics and any ad account and the Channels card stops being blank. |

### Wanted, and honestly not built

- **A CRM.** There is none. Deck links live in a browser and leads land in a
  runtime log. `claude/sales-deck.md` has the four endpoints that fix it, and
  until they exist, "who did we talk to in July" has no answer.
- **Attribution from a deck open to a pilot.** The pieces exist separately —
  gated opens on one side, tenants on the other — and nothing joins them.
- **Anything on the website.** `cuesea.ai` is outside this repo. I can write
  copy for it; I cannot currently see or change it.

## Things worth knowing that you did not ask

Three, because you asked what you might not realise.

**1. The decks can tell you what was read, not just that they were opened.**
`deck.js` already observes sections for its reveal animations. The same
observer could report *which sections a reader dwelled on* — an investor who
re-read the bear case and a merchant who skipped straight to pricing are two
different conversations, and you would know before the call. It is perhaps
twenty lines. It is also surveillance of a named person's reading, so it wants
saying out loud in the deck's own privacy line before it ships, not after.

**2. The known-edges section is a marketing asset, not a liability.** It is the
cheapest trust in the whole document, and nothing else you send will do the
same job. If it ever gets softened to win one deal, it stops working for every
other one. Worth protecting the way the gate sentence is protected.

**3. The product generates its own best marketing material.** Every real
engagement is a story with a number on it — the leaderboard, the requests
panel, "cues per hour worked" — and the analytics to pull an anonymised version
already exist. A pilot's own before-and-after, told with their permission and
their numbers, beats any claim we write ourselves. The first pilot that
finishes is the first case study, and the data for it is already being kept.

## What this tab is not

Not a dashboard of invented metrics. Every number here traces to something the
system genuinely observed, or the space is blank and says why. The moment this
panel shows a plausible-looking figure nobody can source, it becomes the place
those figures get quoted from — and an internal tool that launders guesses into
facts is worse than no tool.

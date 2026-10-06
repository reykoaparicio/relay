# Relay: presentation script

**Audience:** software engineering leads and business decision-makers
**Length:** about 9–10 minutes plus questions (around 25 seconds a slide)
**Files:** `Relay.pptx` (PowerPoint or Keynote, script in the speaker notes) or `relay-deck.html` (open in a browser; arrow keys or space to move, `F` for full screen)

> **Claims discipline:** say only what is built and tested. Relay is a working desktop prototype. Every screenshot comes from the real app running on a sample project with test providers. A live run against the real providers is the next milestone, not done yet. Do not call it "production-ready", give customer numbers, or promise savings figures.

---

## 1 · Cover: "Relay — AI on your code, with the brakes on."

Hi, I'm here to show you Relay.

In one line: Relay lets your team use AI on real code, and you stay in control of three things: what it costs, what it sees and what it changes.

It's a desktop app for macOS, and it works with the API keys your company already has.

## 2 · The problem

Most of your teams already use AI to help with code. It's fast. But for a company it isn't trustworthy yet, for three reasons.

- **Cost.** Nobody knows what a task costs until the provider bill arrives.
- **Data.** Nobody can say for sure which files, or which secrets, were sent.
- **Changes.** Code changes land without a plan anyone actually approved.

Those three gaps are why AI stays a personal tool and never becomes a team process.

## 3 · What Relay is

Relay is a control layer that sits between your code and your AI provider.

It runs a repeatable workflow: review the code, plan a fix, draft a patch, check the patch. Spending is visible at every step, and nothing is drafted until a person approves the plan.

Let me show you the real app.

## 4 · In the app: overview

This is the project overview, and everything that needs you is on this one screen.

- On the left, a run is waiting for my approval.
- Next to it is what we've spent so far this month.
- On the right are the limits for this run: the allowance, how many revision cycles it may take, and the fact that it can only *draft* a patch.

Notice the line "No project files have been modified." That line comes back later.

## 5 · How a run works

Every run is five steps: **review, plan, approve, patch, verify.**

Each step can use a different model, even a different provider. A cheap, fast model can do the review and a stronger one the patch.

Step three is yours. Relay stops, shows you the plan, and waits. You can approve it, ask for a revision, or reject it. Nothing else happens until you decide.

## 6 · In the app: approval

This is the approval screen. The plan is concrete: each item names the finding it fixes and the files it's allowed to touch.

From here you can pause the run, cancel it, or export it. Approval is tied to this exact version of the plan, so if the plan changes, you approve again.

## 7 · Relay never edits your project files

This is the most important design rule: **Relay never edits your project files.**

What you get is a report and a proposed patch. You review the patch and apply it yourself, with your normal tools and your normal code review.

So the worst case is a bad suggestion, not a broken codebase.

## 8 · Cost you can see

Now cost. Before every single call, Relay reserves the most that call could cost. If that would go over your budget, the call is never sent.

- **Budgets** are set per run and per project per month. If a run hits its limit it pauses, and you can raise the limit in place.
- **The numbers are honest.** When we know the exact cost, we show it. When we can't, we show an estimate, marked as an estimate, and never "unknown".
- **There are no surprise retries.** A request that may already have been charged is never re-sent without you.

## 9 · In the app: budget pause

Here's a budget pause. The next request needed 11 cents and only 6 cents remained, so nothing was sent.

What matters is that it shows the math. You can see the allowance, what's already been used, what's reserved, and the formula. A finance person can check this line by line.

You then choose: raise the allowance, switch to a cheaper model profile, or stop. Every finished step is kept either way.

## 10 · In the app: uncertain cost

Sometimes the network drops in the middle of a request, and nobody knows whether the provider finished it.

Most tools either hide that or quietly retry it, and quietly retrying can mean paying twice.

Relay counts it as an estimate, here about 6 cents, notes that it may not have been charged, and asks you to retry the step or stop. It never retries on its own.

## 11 · Your data stays yours

On data: only what you pick leaves your Mac.

- Projects, runs, history and memory are stored locally on your computer.
- For each run you choose the files. The run records exactly which files went to which provider.
- Key and credential files are blocked outright. Files that *look* like they contain a key need your OK.
- API keys live in the macOS Keychain. They never appear in logs, exports or the interface.

## 12 · Bring your own key

The business model is simple: bring your own key.

Relay works with **Anthropic, OpenAI and Google Gemini**. Companies plug in their own keys and pay the providers directly, under the contracts and data terms they already have.

Relay adds the control, not a markup on tokens.

## 13 · In the app: per-step models and limits

When you start a run, you pick a model and an output limit for each step.

Each step comes with a sensible default, so most people never touch these boxes. A team that wants tight control can set every one of them.

## 14 · In the app: providers

Connecting a provider takes about a minute. You paste a key and Relay tests it with a tiny request, then stores it in the Keychain.

From then on you only ever see a redacted label like this one. You can test, replace or remove the key at any time.

## 15 · Pause, export, recover

You're always in control of a running job.

- **Pause** stops after the current request and later resumes exactly where it left off.
- **Export** saves everything finished so far, even in the middle of a run.
- **Crash recovery:** if the app crashes or the laptop restarts, runs are kept safe and can be resumed.
- **Backups:** daily automatic backups, with a one-click restore.

## 16 · Project memory

Relay also learns your project's rules, but only with your approval.

When a run finds something worth remembering, like "this project validates input with this helper", it *suggests* a rule. Nothing is added automatically.

Approved rules are reused in future runs, and every rule keeps its source, its history and a review date.

## 17 · In the app: the report

Every run ends in a clear report: the goal, the verdict, which models were used, the findings, what was approved, any limitations, and the tracked cost. It exports as Markdown, so it can go straight into a ticket or a pull request.

And the green banner at the top is the promise from earlier: "Original project files were not modified."

## 18 · In the app: memory

This is project memory. You see the approved rules with their source and scope. Suggestions wait in their own tab until someone reviews them, and they're kept out of future runs until they're approved.

## 19 · Built to be trusted

We built and tested Relay like it handles money, because it does.

- More than 3,600 automated unit tests.
- 120 integration tests, including crash recovery.
- 43 end-to-end tests that drive the real desktop app.
- Zero secrets found by the release scan.

It has also been through separate security, money, UI and resilience audits, each followed by fixes and a bug hunt.

## 20 · Who it's for

Relay is for teams that already pay for AI and want it to be predictable.

- **Engineering leads** need AI help their team can audit and approve.
- **Developers** want a reviewed plan and a clean patch, not a chat transcript.
- **Budget owners** need hard spending limits and a ledger they can export.

## 21 · Where we are

Here's where we are, honestly.

The prototype is complete: the full workflow, the desktop app, packaging, and the audits.

Next is real-world proof:
- a live run against all three providers;
- a signed macOS build;
- our first pilot teams.

## 22 · Thanks: "Let's run it on your code."

That's Relay: AI on your code, with the brakes on.

We're looking for pilot teams. If you have a codebase and an AI bill you'd like to make predictable, let's talk.

Questions?

---

## Likely questions (short answers)

- **"Why a desktop app and not a service?"** Your code and keys stay on your machine. Only the files you pick go to the provider you chose.
- **"Does it replace code review?"** No. It feeds code review. Relay drafts the patch and you apply it through your normal process.
- **"How accurate are the cost numbers?"** They're exact when the provider reports usage. Otherwise they're an estimate from the request and response size, labelled as one. The provider's bill stays the source of truth, and the app says so.
- **"Which models?"** Claude, GPT and Gemini models, and you can set them per step.
- **"Is it in production?"** Not yet. It's a tested prototype. The live provider run, the signed build and the pilots are the next steps.

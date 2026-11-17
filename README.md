# Smart Prompt for Claude Code

A Claude Code mod that turns a rough draft in the prompt box into a clear prompt the agent can act on, in one click.

Type your request the way you'd say it, press **✦ Refine** above the prompt box, and the draft is replaced with a cleaner version. Paths, names, numbers, URLs and code from your draft are kept exactly as you wrote them.

The Claude Code edition of [dsh-smart-prompt](https://github.com/Arrosam/dsh-smart-prompt) 1.3.0. It uses the same rewriting prompts and the same fidelity check.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install smart-prompt --marketplace Arrosam/claude-smart-prompt
```

Answer `y` to add the marketplace, then pick a scope (user scope is the first option).

From a shell:

```bash
claude plugin install smart-prompt --marketplace Arrosam/claude-smart-prompt
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Arrosam/claude-smart-prompt`, then **Add plugin**.

## Use it

1. Type a draft, for example:
   > can you change maxRatioFor in src/host/config.ts to 2.5 and check it with `pnpm build`
2. Press **✦ Refine** in the row above the prompt box. A few seconds later the draft becomes:
   > Change `maxRatioFor` in `src/host/config.ts` to `2.5`, then verify with `pnpm build`.
3. A short note under the button shows how many hard facts were kept, the length change, the time taken and the tokens used, as `input(cached) - output`.
4. Not happy with it? Use **Revert | Retry | Iterate**:
   - **Revert** goes back one version: the rewrite before your last Iterate, or your original draft.
   - **Retry** makes a new version from the same starting point as the current one.
   - **Iterate** improves the rewrite again, in the mode that made it.

   They stay until you edit or send the draft.

Press **Cancel** while it's working to stop. If anything goes wrong, your draft is left as it was and a short note says why.

You can also run `/refine <draft>`. A slash command in the draft keeps its name: in `/bugfix <text>` only the text is rewritten.

### Modes follow your model

There's no mode picker. Smart Prompt picks the mode from the model your session runs on, and shows it next to the button:

| Session model | Mode | What it does |
|---|---|---|
| Fable, Opus | **Light** | Removes filler and clears up ambiguity, keeping the draft's structure (at most 2× the draft, or 600 characters). |
| Sonnet | **Standard** | Restructures the draft so an agent can run it: deliverable, constraints, steps, output format. |
| Haiku | **Detailed** | Ordered steps, cautions, and the exact standard for every concrete detail, so the agent never has to guess. |

The more capable the model doing the work, the less spelling-out its prompt needs. Switch models with `/model` and the next refine follows.

Every refine, and every next-step suggestion, runs on the **latest Opus at low effort**, whichever model your session uses. It reads the latest turns of the conversation, so "fix what you just mentioned" is rewritten with that context.

### Follow-up questions

If the draft is missing something only you can decide (which endpoint, what limit, which option), the row above the prompt box shows a question and your draft steps aside. Type the answer in the prompt box and press **Answer**; your draft comes back afterwards.

- **I don't know**: the prompt tells the agent to find it out, or to propose options and carry on with the most reasonable one.
- **Skip**: no more questions.
- **×**: cancels the refine and puts your draft back.

In **Standard** and **Detailed** the questions come one at a time, up to the limit (default 5). Once asking ends, any remaining gaps are filled with guesses, listed under **Guessed details** at the end of the rewrite so you can check them. In **Light**, all of the questions come first and the prompt is rewritten once; gaps you skip stay as `(TBD: …)` notes.

### Next-step suggestions

With the prompt box empty after Claude's reply, press **✦ What to ask next**. Two likely next messages appear, written in your voice and language. Press one (or its number key in an empty prompt box) to put it in the prompt box. **✦ 2 more** adds two different ones; **×** closes the list. The suggestions are kept until Claude replies again.

## What it guarantees

- **Nothing important is lost.** Before rewriting, Smart Prompt lists the hard facts in your draft: file paths, identifiers, numbers and versions, URLs, `code` and @mentions. Then it checks that each one survived. If any was dropped, the model gets one more try; anything still missing is added back at the end under "Preserved original details".
- **Nothing is invented.** Gaps are asked about, not padded with made-up requirements. A guess is always listed under **Guessed details**.
- **No runaway length in Light mode.** A longer result gets one chance to shorten; if it's still too long, your draft is kept.

## Settings

```
/smart-prompt                     show the settings
/smart-prompt questions <0-10>    most follow-up questions per refine (default 5; 0 turns them off)
/smart-prompt auto <on|off>       suggest next steps after every reply (default off: one extra Opus call per reply)
```

Settings are kept across sessions.

## Differences from the DSH plugin

- The mode follows the session model instead of being picked by hand.
- Rewrites always run on the latest Opus at low effort.
- Not ported yet: Stardea (星念) answer ideas, attachments sent to the rewriting model, session lookup tools, and `SMART-PROMPT.md` workspace notes.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
claude --plugin-dir .
```

`hooks/prompts.ts` is generated from `prompts/*.md` in dsh-smart-prompt 1.3.0; regenerate it rather than editing it by hand.

## Licence

MIT. Built on dsh-smart-prompt, itself a fork of [dsh-improve-prompt](https://github.com/hoyyang/dsh-improve-prompt) by hoyyang.

🧠 What Adnota Is (And What It's Really Trying to Do)
The surface-level pitch is "erase stuff from web pages." But the deeper idea is much more interesting: the web is static for the reader but that's a convention, not a constraint. Adnota is a bet that people want to be editors of their own browsing experience — curators, not just consumers. That's a real and underserved need.

The web was designed so publishers author the page. Adnota flips that. The user authors their experience of the page. That's the core philosophical proposition and it's genuinely worth pursuing.

✅ Strengths
1. The technical architecture is exceptionally thoughtful for a browser extension. The FuzzyAnchor layered confidence system (ID → XPath → semantic → geometry) is real engineering. Most hobbyist extensions skip this entirely and break every time a site does a minor deploy. This one is built to survive the web.

2. Privacy-first is a feature, not a limitation. "No accounts, no cloud, no data leaving the browser" is a genuine competitive advantage right now. Every consumer product is drowning in surveillance capitalism. Adnota's local-only default is trust-building and positions it well with privacy-conscious users (developers, researchers, journalists, legal/medical professionals).

3. The schema is forward-thinking. version field from day one. attachedNoteId reserved in the highlight schema. comments[] array in sticky notes. These are the decisions of someone who has shipped production code and gotten burned by migration debt. That discipline will pay off massively.

4. The tool suite is coherent. Eraser + Sticky Notes + Highlighter + Marker isn't a random pile of features. These are four facets of the same core verb: annotate. They reinforce each other. A user who erases clutter can then highlight signal without noise. Someone who marks up a page with the pen might drop a sticky with "follow up on this." The affordances compound.

  -- What if we added REMINDERS? Like in reddit??

5. The UX details are humane. The 5-second undo window on deletes. The dissolve animation. The debounced autosave. The popup stat cards that crossfade to trash icons. These signal someone who cares about the feel of using the tool, not just its function.

⚠️ Weaknesses
1. The retention problem is the existential risk. The biggest question isn't whether the eraser works — it's whether users will remember Adnota exists. Browser extensions have a brutal discovery-to-habit gap. A user installs, erases their first sidebar, thinks "neat," and never returns. There's no pull mechanism to bring them back. No push notification, no ambient reminder, no social proof from others using it. The Sites history page helps, but only if the user voluntarily opens it. Habit formation is the missing layer.

2. "Erase distracting elements" is a weak top-level pitch. It describes the mechanic, not the need. The Notion homepage doesn't say "create documents." It says "write, plan, share." Adnota needs a sharper emotional hook. Who is the canonical user? A researcher buried in cluttered academic pages? A developer reading docs? A student annotating readings? A journalist redacting before screenshotting for a story? Right now it's trying to serve all of them equally, which means it emotionally resonates with none of them at acquisition.

3. The 5MB chrome.storage.local cap is a real ceiling. The Ramer-Douglas-Peucker compression on strokes is smart, but a power user who annotates heavily across dozens of sites will hit this. There's no graceful degradation strategy — no warning, no auto-pruning of old edits, no indication the cap is approaching. This will bite someone eventually and feel like data loss.

4. No identity layer means no portability. This is acknowledged and deferred, but it's worth calling out how deeply it limits the product. Right now your annotations are trapped in a single browser on a single machine. Switch computers? Gone. Reinstall Chrome? Gone. This isn't just about "cloud sync as a premium feature" — it's a fundamental fragility. A user who builds a rich annotation set and then loses it will feel genuinely betrayed.

5. The broken anchor problem is quietly sharp. The < 70% confidence → silent skip decision is aesthetically clean but epistemically dishonest. The user thinks their erasure is applied. They refresh the page. The sidebar ad they deleted is back. They don't know why. The product plan mentions surfacing this in the popup ("1 edit couldn't be applied"), but that's still cut in the current build. This is the single most important trust-eroding edge case to fix.

6. Discovery of annotations on visited sites is passive. The Sites history page is great, but it's opt-in navigation. There's no ambient signal in the browser that says "you've modified this page." A tiny badge on the extension icon (the way 1Password shows it's active on a site) would do enormous work here.

💡 What Could Make This a Great Product
1. The killer use case is redaction + screenshot. The black highlight (redaction mode) is the most uniquely powerful feature and it's buried. If Adnota let users: (a) black-out sensitive fields, (b) erase surrounding noise, and then (c) hit one button to export a clean, redacted screenshot — that's a workflow journalists, legal professionals, HR teams, and security researchers would pay for. That's a real premium feature with a real audience. Build around it.

2. "Share your read" as a social layer. Imagine sending someone a link and they open the page with your annotations already applied. Highlighted in green: the important parts. Erased: the noise. Stickied: your commentary. This is the collaborative layer that makes Adnota viral. You'd need cloud sync first, but the architecture was designed with this in mind. When you ship it, frame it as "annotated links" — the way Genius annotates lyrics. This is the feature that makes someone tell a friend about Adnota.

3. Reading mode as a real product category. Erase + Highlight + compress = a custom reading mode for any page. Pocket and Instapaper strip pages down to text. Adnota can strip your specific distractions while keeping your chosen signal. That's more personal and more powerful. Lean into the "your personal lens on the web" framing.

4. Extension badge as ambient feedback. A simple badge counter showing how many edits are active on the current page (the way uBlock Origin shows the count of blocked requests) would massively close the retention gap. Users would see the extension working on every annotated page, which triggers recall and builds habit.

5. The education market is a natural fit. Students annotate. Researchers annotate. Teachers annotate and share annotated readings with students. If Adnota shipped a "share annotated page" feature even as a JSON export that another Adnota user can import, it immediately becomes a study tool. That's a growth vector with built-in community dynamics.

6. Fix the silent anchor failure, loudly. Make the broken anchor surfacing the top priority above all the medium/low roadmap items. Trust is the product. The moment a user's edits silently disappear — even once — is the moment they stop relying on it.

🏛️ The Philosophical Point (Which You Asked About)
Why should the web be set in stone? Why not give users the control to make it more fluid and dynamic?

The blunt answer: because publishers have the most incentive and the most infrastructure. The web is "set in stone" for readers because it serves publishers to keep it that way. Ad revenue depends on ads being visible. Engagement metrics depend on sidebars and suggested content. Cookie banners are dark patterns by design.

Adnota's bet is that enough users care about their own experience enough to push back. That bet has precedent — uBlock Origin has ~40 million weekly active users. People will absolutely install a tool that gives them editorial control over what they consume. The difference between uBlock and Adnota is that uBlock is purely subtractive (blocklist-based), while Adnota is expressive — you're not just removing the noise, you're annotating the signal. That's a meaningful distinction and a much richer product space.

The web as a fluid, personal medium rather than a broadcast medium is a genuinely good idea. The tension is that most people don't know they want that until they experience it. The first erase — the first time a user kills a nav bar they've been unconsciously tolerating for months — is a "holy shit" moment. The entire product's job is to engineer more of those moments and help users remember them.

The verdict: Adnota is technically excellent, philosophically interesting, and in search of a sharper story and a retention mechanism. The bones are strong. The product needs a canonical user, a trust-repair plan for broken anchors, and one killer workflow (probably redaction → screenshot) that makes someone say "I need this."




    "toggle-styler": {
      "suggested_key": {
        "default": "Alt+L",
        "mac": "Alt+L"
      },
      "description": "Toggle CSS Nudge (Layout) Mode"
    }

chrome.storage.local.remove('adnotaDockPosition')

chrome.storage.local.get('readaloudrevival.com', (d) => console.log(JSON.stringify(d, null, 2)));

    turn on debug logging for bubbling up parent elements:
    localStorage.setItem('adnota-debug-bubble', '1')
    localStorage.removeItem('adnota-debug-bubble')
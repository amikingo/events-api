# Prompt for a browser-testing agent (Antigravity or Gemini)

Copy everything below the line into the agent. Replace the three `<…>` values first.

---

You are testing a web app for event registration that runs on this computer. Follow these rules exactly. If you can't follow one, stop and tell me.

**Rules:**
1. **Work only in the organization "<PILOT ORGANIZATION NAME>"** at `http://localhost:3000`. If you ever see a different organization's name in the top bar, or any page outside `http://localhost:3000`, stop at once and tell me.
2. **I sign in for you.** Never type, read, copy or store a password, a one-time code or a token. When a sign-in screen appears, stop and say "Please sign in as <ROLE>".
3. **No payments of any kind.** This app is free registration only. If you see a payment screen, stop.
4. **Only one real phone number may be used: <TESTER MOBILE>.** Use it only where a step says so. For any other guest, use the fake names and the numbers 0911 000 101 to 0911 000 109.
5. **Stop after each step.** Report:
   - what you did;
   - the exact messages on screen (copy the wording);
   - a screenshot;
   - anything that looked wrong.

   Then wait for me to say "next".
6. **Check each screen twice:** at 375 px wide (phone size), and in dark mode (the avatar menu, then Theme, then Dark). Report anything cut off, overlapping or unreadable.
7. **Times must never show in 24-hour form** (for example "14:00"). Event dates must show the Ethiopian date first (for example "Hidar 18, 2019 at 3:00 in the morning"), then the Gregorian date with AM/PM. Report any place that breaks this.

**Steps:**

1. **Staff window, signed in as the Owner (ask me to sign in).**
   - Open *Events*.
   - Create "Tester Forum": tomorrow 9:00 AM to 5:00 PM, capacity 2, visibility Public.
   - Use the time chooser, and confirm it shows hour, minute and AM/PM.
   - Report the messages.
2. **Cover:** on Tester Forum's *Cover* tab, upload any JPEG or PNG under 5 MB from this computer. Report what you see.
3. **Publish:** press *Publish event* and confirm. Report the confirm text and the dates shown on the record.
4. **Visitor window (a private window; no sign-in).**
   - Open `http://localhost:3000/events`.
   - Find Tester Forum and report how its date is shown, whether a cover shows, and any badges.
5. **The event page:** open the event. Report the date text, the privacy notice and the form fields.
6. **Register a guest:**
   - first name "Test", last name "Guest One";
   - mobile <TESTER MOBILE>, **pasted** as +251… (check that all nine digits stay);
   - tick the privacy box, then *Register*.
   - Report the code and the messages.
7. **The guest list:** back in the staff window, open Tester Forum, then *Guests*. Report:
   - the guest row (how many times the guest appears, and its source);
   - the confirmation status, then again after 15 seconds;
   - the summary.
8. **Register as staff:** use *Register a guest*, new guest "Test Guest Two", mobile 0911 000 102. Report the summary.
9. **A full event:** in the visitor window, register "Test Guest Three", 0911 000 103. Report the message; the event should be full.
10. **Cancel:** in the staff window, cancel Test Guest One and confirm. Report the summary. Then press *Bring back* and report the code; it should be the same as in step 6.

When all steps are done, give me one list of everything that failed or looked wrong, in step order.

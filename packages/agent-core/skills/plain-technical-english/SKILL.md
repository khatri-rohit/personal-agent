---
name: plain-technical-english
description: Write answers, plans, reviews and docs in controlled plain English (rules adapted from ASD-STE100) so every sentence has one meaning. Load when the user asks for this style, or for text another person or agent will act on.
---

# Plain technical English

These rules come from ASD-STE100 (Simplified Technical English). They make each sentence have one meaning, so the reader acts on it correctly. They apply to prose. Code, commands, paths, error text and quoted text keep their exact form.

## Words
1. Use one word for one thing. Do not change the word to sound varied. Use the name the code, the user or the document already uses.
2. Use a word with its most common meaning. "Run" means execute, not manage.
3. Use concrete nouns: file, function, error, limit, version. Do not use "solution", "aspect" or "approach" when a specific noun exists.
4. Use "can" for ability. Do not use "may" or "might": each has two meanings (permission and possibility). State the condition instead.
5. Do not use hedges or intensifiers: perhaps, maybe, probably, basically, simply, actually, really, very, quite.
6. Define an abbreviation the first time you use it, unless the reader uses it already.

## Sentences
1. Write one instruction per sentence. Split "Read X, then fix Y if Z" into three sentences.
2. Keep a step to 20 words or fewer. Keep a description to 25 words or fewer.
3. Use the imperative for an instruction: "Run the tests." Use a statement for a fact: "The test fails at line 40."
4. Use active voice. Name who or what acts: "The parser drops empty strings", not "Empty strings are dropped".
5. Put the condition first: "If the build fails, stop and report the error."
6. Write a warning or caution as its own sentence, before the step it applies to.
7. Do not join sentences with semicolons to make one long sentence.

## Structure
1. Put the result or the answer first. Then the evidence. Then what is open.
2. Number the steps of a procedure. One action per step.
3. Use a list for items that are separate. Use prose for an explanation.
4. Give each paragraph one topic.
5. Stop when the reader can act. Do not add a summary of what you already wrote.

## Examples

Not this: "You might want to consider possibly running the tests again, since it seems like the earlier failure could have been flaky."
This: "Run the tests again. The earlier failure can be flaky: it passed on the second run in CI."

Not this: "The config gets loaded and then validated, and if anything is wrong an error is thrown, which the caller catches."
This: "The loader reads the config. Then it validates the config. If a field is wrong, the loader throws an error. The caller catches it."

Not this: "Great question! There are several aspects to consider here."
This: "Use Postgres for sessions. You already run it, and the write load is low."

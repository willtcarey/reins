# Secrets

Give an agent the credentials it needs (API keys, tokens, passwords) without putting them in the chat. The agent asks; you enter the values in a masked form; Reins keeps them encrypted, and the agent gets a reference to each value, never the value. A built-in extension ([extensions.md](extensions.md)); turn it off in Settings → Extensions.

## How it works

1. **The agent asks.** It names the variables it needs (for example `OPENAI_API_KEY`), says why, and describes each. Then it ends its turn and tells you. It does not wait: you can answer later.
2. **You answer in the session.** When you go to the session that asked, a form opens in the Inspector: the purpose, and one masked field for each name, with a control to show or hide it. Each value is one line of at most 16 KiB. Choose **Store secrets**, or **Cancel**. After a page reload, or in another browser, the form opens again until the request is answered; once one browser answers, the form's tab closes, in that browser and in the others.
3. **The agent continues.** Reins wakes the session with a message, "sent from secrets": that you entered the values, and a reference (a handle) for each. If you cancel, the message says so, and nothing is stored.
4. **The agent uses a value.** In a script, it reads the value by its handle and gives it to a command as an environment variable, for example to add a line to a `.env` file. The value is not in the command's text, in the conversation or in the server's log.

## What is kept, and for how long

- The values are in Reins' secret storage, encrypted with the server's key. The browser sends them only when you store them.
- A handle reads only its own value. An agent cannot list stored secrets or read one it was not given.
- A secret is deleted 7 days after its last use (or after it was stored, if it was never used). **Settings → Secrets** lists the stored secrets by name, without their values, with **Delete**, and the requests no one has answered, with **Cancel**.
- Deleting a secret removes only Reins' copy: a value already written to a file stays there.

## Limits

An agent with a shell can read a file it wrote a secret into, or a script can return a value it read. The agent is told never to do this, but nothing prevents it, and the model's output is not redacted yet.

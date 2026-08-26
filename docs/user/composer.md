# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

On servers that support direct uploads, images upload as soon as you add them. The send button
becomes available after every upload finishes. Failed uploads can be retried or removed.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, T3 Code hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.

## Pasted text

On web and desktop, pasting at least 1,000 characters or 20 lines collapses the pasted block into a
**Pasted text #1** badge. Each badge can be expanded or hidden without changing the draft. Badge
numbers always follow their current order, so deleting an earlier block renumbers the remaining
ones.

Sent messages keep the same expandable badges on web, desktop, and mobile. Copying a message and
the text sent to the agent both use the complete original content; the badges are only a visual
presentation.

## New thread defaults

Set which model every new thread starts with under **Settings > General > New thread model**, so
you are not adjusting the model picker before each first message. Set each provider's traits and
permission mode in its card under **Settings > Providers**.

- **New thread model** is either the last model you used (the default) or one specific model.
- Each enabled provider has its own defaults for the traits it supports, such as reasoning effort,
  context window, and speed, plus a permission mode. The trait values shown are what new threads
  on that provider start with; traits a model does not offer are skipped. Reset a provider's
  defaults to return every model to its own defaults.

A new draft opens with the chosen model and that provider's defaults already applied. Switching to
another provider in an unstarted draft applies that provider's defaults and permission mode. A
draft keeps following your current defaults until the thread starts; your typed prompt is never
affected. Threads that already started are not changed.

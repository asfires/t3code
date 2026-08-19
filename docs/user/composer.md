# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

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

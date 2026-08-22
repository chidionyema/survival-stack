# Setting up the Survival Stack

This is the whole setup, explained in plain English. It takes about twenty
minutes. Most of that is opening other websites to fetch tokens, not waiting
for anything.

You do not need to understand the stack to do this. You need a browser, a
phone, and a Cloudflare account.

---

## 1. What you are actually setting up

The Survival Stack runs your shop. It has three parts.

**The control plane.** A small program that runs on Cloudflare, in their
network, not on any server you rent. It is the brain. It builds servers,
watches them, moves your domain from one to another when one dies, and takes
instructions from you over Telegram.

**The boxes.** Ordinary rented servers that run your actual shop. They are
disposable. The control plane builds them from scratch and throws them away.
Nothing important lives on them.

**The lighthouse.** A single web page that keeps working when every server is
gone. It shows your catalog and takes orders, saving them until a server comes
back.

Setup is about giving the control plane the keys it needs to do all that. That
is all it is. Nothing gets built or spent today.

---

## 2. What setup asks you for, and why

Nine things. Four are required. The rest you can add later by running setup
again.

| What | Required | What it is for |
|---|---|---|
| Cloudflare login | yes | Where the control plane lives |
| Cloudflare API token | yes | Lets the control plane move your domain |
| Your domain | yes | The address customers type |
| A code from your phone | yes | Proves it is you before anything spends money |
| Telegram bot | yes | How you give orders |
| A server provider | strongly | Where a new box gets built |
| R2 keys | strongly | Where your database is backed up |
| Stripe key | only to charge | Taking payment |
| SSH key name | no | Getting into a box by hand if you ever need to |

### Get these ready first

You can fetch them as you go, but having them open in tabs makes it one sitting.

**A Cloudflare account with your domain in it.** If your domain is not on
Cloudflare yet, do that first. It is free and it is the one thing setup cannot
do for you.

**A Cloudflare API token.** Go to
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens),
press Create Token, then Create Custom Token. Give it two permissions:
**Zone → Zone → Read** and **Zone → DNS → Edit**. Under Zone Resources pick your
domain. Copy the token when it shows it to you. It is shown once.

**A Telegram bot.** Open Telegram, search for
[@BotFather](https://t.me/BotFather), send it `/newbot`, and answer its two
questions. It gives you a token that looks like `123456789:AAxxxx...`. Copy it.

**A server provider account.** Hetzner is the cheapest and the one to start
with. Make an account, then make an API token in the Cloud console under
Security → API Tokens, with Read & Write. DigitalOcean and Vultr work the same
way, and you can add them later.

**R2 keys.** R2 is Cloudflare's storage. In the Cloudflare dashboard go to R2,
then Manage R2 API Tokens, and create one with Object Read & Write. It gives
you two strings: an access key id and a secret access key. Copy both.

**A Stripe key.** Only if you are taking money today. Stripe dashboard,
Developers, API keys, the live secret key starting `sk_live_`.

**An authenticator app on your phone.** Aegis, 1Password, Google Authenticator,
any of them. You do not need to set anything up in it yet. Setup will show you
a QR code to scan.

---

## 3. Opening the setup page

Open Finder. Go to your `survival-stack` folder. Double-click
**Set up Survival Stack.command**.

A terminal window opens and says a couple of lines. Ignore it. A browser tab
opens with the setup page. That page is the thing you use.

If you would rather type a command, this does the same:

```bash
npm run secrets
```

**Two things worth knowing.** The page is only reachable from your own laptop —
nobody on your network or the internet can see it. And the link has a random
code in it, so a website you happen to be visiting cannot poke at it either.

If you close the tab by accident, the terminal window still has the link in it.
Copy and paste it back into your browser.

---

## 4. Filling it in

The page is a list of cards. **Fill them in whatever order you like.** Nothing
is sequential and nothing is stored until you press the button at the bottom.

Each card has a small dot next to its name.

- **Grey** — you have not filled it in yet.
- **Green** — the service it belongs to confirmed it works.
- **Red** — something is wrong, and the line underneath says what.

That green dot is not the page being polite. It means the page actually called
Cloudflare, or Telegram, or Stripe, and that service said yes. A token that
looks right but does not work turns red here, which is much better than
discovering it at two in the morning when a server has died.

### Cloudflare account

Press **Log in to Cloudflare**. A Cloudflare page opens in a new tab asking you
to approve it. Press Allow.

Come back to the setup page. It says "waiting for you to approve it in the
browser" and turns green a second or two after you do. You do not need to
hurry, and you do not need to watch the terminal.

If it does not go green, press the button again. Nothing was stored, so trying
again costs nothing.

### Your domain

Paste your Cloudflare API token into the box.

A moment later a dropdown appears listing every domain on your account. Pick
the one you are using.

The page then finds the A record for your domain. If there is no A record yet,
it makes one pointing at a parked address that goes nowhere. That is normal and
correct — the first server you build overwrites it.

This is the step that used to ask you for a zone id and a DNS record id. You do
not need either. The page reads them off your account.

### Your phone

A QR code is already on screen. Open your authenticator app, add a new entry,
and scan it.

Your app now shows six digits that change every thirty seconds. Type them into
the box and press **Check**.

If it says the codes agree, you are done. If it does not, the usual cause is
your phone's clock. Turn on automatic time on the phone and try again.

**Do this bit properly.** Every action that spends money asks for one of those
codes. If your phone does not have the entry, you cannot build a server, and
setup is the only time this code is shown. There is a "can't scan" button that
shows the text version if your camera will not cooperate.

### Telegram

Paste your bot token. The card goes green and tells you the bot's name, which
is a useful check that you pasted the right one.

Now open Telegram on your phone and send your bot literally anything. "hello"
is fine. Then press **Now message your bot, then press this** on the setup page.

The page listens, hears your message, and works out your chat id from it. This
saves you hunting for @userinfobot.

If it says no message yet, send another one and press it again.

### R2 keys

Paste both halves — the access key id and the secret access key.

The page signs a real request and sends it to Cloudflare's storage. Green means
the keys work. Red means they do not.

**This is the one worth getting right.** These keys are used by a background
process on a server you never look at, to copy your database to storage every
few seconds. If they are wrong, nothing complains. Backups just quietly never
happen, and you find out when you need one. So the page checks them properly
rather than trusting the shape of the string.

### Providers

Paste a token for each provider you have. You need at least one. Hetzner is the
one to start with.

Each one goes green and tells you how many SSH keys that account has. Those key
names then fill the dropdown at the bottom of the card, so you do not have to
remember what you called yours.

Any provider you skip is simply not offered when you go to build a box. You can
add another one later by running setup again.

### Stripe

Only needed to take money. Paste your live secret key.

The page asks Stripe about it and tells you whether it is a live key or a test
key. That matters — a test key looks identical and takes orders that never
charge anyone.

---

## 5. The button

When the four required cards are green, **Set it all up** at the bottom becomes
pressable. Until then, the line next to it names exactly what is still missing.

Press it. The page turns into a running list. Here is what each line means.

**Creating the KV namespace.** A small, fast store on Cloudflare. It holds
short-lived things: which server is currently live, and which one-time codes
have already been used.

**Creating the two R2 buckets.** Bigger storage. One holds the audit log —
every action ever taken, so you can see what happened. The other holds your
catalog and any orders taken while the servers were down.

**Writing wrangler.jsonc.** Filling your domain and the ids it just made into
the config file.

**Storing each secret.** Every value goes into Cloudflare's encrypted secret
store, one at a time. You will see each one named as it goes in. The values
themselves are never shown, never logged, and never written to your laptop.

**Deploying the Worker.** The control plane goes live. Cloudflare gives it a
web address.

**Telling the Worker its own address, and deploying again.** This looks odd and
is necessary. A new server, once it boots, has to phone home to say "I'm alive".
It cannot do that without knowing the address — and the address does not exist
until the first deploy has finished. So: deploy, read the address, write it
into the config, deploy again.

**Pointing Telegram at the Worker.** Telling Telegram where to send your
messages, with a secret password so nobody else can send fake ones.

**Sending you a message.** The last step, and the real test. Everything before
this proves a thing was configured. This proves the whole chain works
end to end.

**Check your phone.** When that message arrives, setup worked. Send the bot
`/status` and it should answer.

---

## 6. If something goes wrong

**Nothing is half-done.** If a step fails, the page stops there and says why.
Everything before that point already happened and does not need repeating.
Everything after it did not.

**Running setup again is always safe.** It skips anything that already exists
and overwrites secrets with whatever you give it.

Some things you might see:

**"Cloudflare rejected this token".** The token is wrong, or it is missing a
permission, or it does not cover the right domain. Make a new one with
Zone → Zone → Read and Zone → DNS → Edit.

**"the token works but cannot read zones".** You made the token but left off
Zone → Zone → Read. Add it.

**"no message yet — send your bot anything".** Your message has not reached
Telegram's servers yet, or you messaged a different bot. Send another and press
the button again.

**"that code does not match — check the clock on your phone".** Your phone's
clock is drifting. Turn on automatic time and try again.

**"R2 rejected this key pair".** One of the two halves is wrong. The secret half
is only shown to you once, so if you are not sure, make a fresh pair.

**"Port 8791 is busy".** A setup page is already open somewhere. Close it, or
run `SETUP_PORT=8792 npm run secrets`.

**The login never goes green.** Press the button again. If the browser did not
open, an "Open the approval page" button appears next to it.

---

## 7. Where your secrets end up

**On Cloudflare, encrypted, and nowhere else.** Cloudflare's secret store will
give a value to your running code and to nothing else. Not to you, not to the
dashboard, not to anyone with your password.

**Not on your laptop.** The setup page keeps values in memory while it is open
and hands them straight to Cloudflare. Close it and they are gone. Nothing is
written to a file. Nothing goes in your terminal history.

**Not on your servers.** A running box gets one file, readable only by root,
built fresh each time it boots. Destroy the box and it goes with it.

**The TOTP secret is a special case.** It is created in the page, drawn as a QR
code, and stored on Cloudflare. Your phone holds the only other copy. Take care
of the phone.

If you ever think a value has leaked, the answer is the same for all of them:
make a new one at the service it came from, and run setup again.

---

## 8. What to do next

**Check the bot works.** Send it `/status`. It should reply.

**Put the lighthouse up.**

```bash
npx wrangler pages deploy lighthouse
```

Then open the address it gives you on your phone, once, with
`?api=https://your-worker-address.workers.dev` on the end. It remembers after
that. Add it to your home screen.

**Build your first server, from your phone.** In Telegram:

```
/cold-start hetzner primary 123456
```

The last part is the six digits from your authenticator. The bot will tell you
when the box is up.

**Then read `TASK.md`.** It is the week-by-week plan for going live, with what
each step costs.

---

## 9. Adding something later

Run setup again. Double-click the same file.

Everything already stored stays stored. Fill in only the new card — a second
provider, your Stripe key, whatever it is — and press the button. It skips what
exists and adds what is new.

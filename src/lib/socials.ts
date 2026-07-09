import { pool } from '../db/pool';

// Data layer for Marketing → Socials. Posts (per-network copy) live in social_posts;
// every push to Buffer is logged in social_uploads. These tables are created with raw SQL here
// AND declared in prisma/schema.prisma (models SocialPost / SocialUpload). The schema entry is what
// stops `prisma db push --accept-data-loss` from DROPPING them on deploy — raw-only tables DO get
// wiped (this bit us: social_posts was dropped with 51 rows). Keep both in sync if columns change.

export interface SocialPostRow {
  id: number; slug: string; title: string | null; link: string | null;
  network: string; body: string; kind: string; active: boolean; created_at: string;
  image_url: string | null; relevance_date: string | null;
}

export async function ensureSocialsTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_posts (
      id          BIGSERIAL PRIMARY KEY,
      slug        TEXT NOT NULL,
      title       TEXT,
      link        TEXT,
      network     TEXT NOT NULL,
      body        TEXT NOT NULL,
      kind        TEXT DEFAULT 'news',
      active      BOOLEAN DEFAULT true,
      image_url   TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS image_url TEXT;
    ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS relevance_date DATE;
    CREATE INDEX IF NOT EXISTS idx_social_posts_slug ON social_posts (slug);
    CREATE TABLE IF NOT EXISTS social_uploads (
      id             BIGSERIAL PRIMARY KEY,
      post_id        BIGINT,
      slug           TEXT,
      network        TEXT,
      action         TEXT,
      status         TEXT,
      buffer_post_id TEXT,
      due_at         TIMESTAMPTZ,
      message        TEXT,
      created_by     TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_social_uploads_created ON social_uploads (created_at DESC);
  `);
}

// Google Business posts don't use hashtags — drop hashtag-only lines.
export function stripHashtags(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(#[\w-]+\s*)+$/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

interface SeedArticle { slug: string; title: string; link: string; linkedin: string; facebook: string; }

const SEED: SeedArticle[] = [
  {
    slug: 'cyber-essentials-baseline',
    title: 'Cyber Essentials: the security baseline every UK business should have',
    link: 'https://www.lumenmsp.co.uk/news/cyber-essentials-baseline/',
    linkedin: `Most cyber attacks on UK businesses aren't sophisticated. They're automated, opportunistic, and they go looking for the easy wins — an unpatched server, a reused password, a misconfigured firewall.

That's exactly what Cyber Essentials is designed to stop.

The government-backed scheme covers five fundamentals:
✅ Firewalls
✅ Secure configuration
✅ User access control
✅ Malware protection
✅ Patching / update management

Get those right and you remove yourself from the "easy target" pile — where most damage actually happens. And increasingly it's a condition of winning work: more contracts and supply chains now require certification.

One tip though: a badge earned by ticking boxes won't stop an attack. The value is in implementing the controls properly.

We guide businesses through Cyber Essentials and Cyber Essentials Plus — doing the technical work so the badge reflects real protection.

https://www.lumenmsp.co.uk/news/cyber-essentials-baseline/

#CyberEssentials #CyberSecurity #NCSC #UKBusiness #ManagedIT`,
    facebook: `🔐 One of the most cost-effective things you can do to protect your business: Cyber Essentials.

It's a government-backed certification covering the five security basics that stop the vast majority of common attacks — and it's increasingly needed to win contracts too.

We handle the technical side so your certification means real protection, not just a form filled in.

Find out what's involved 👉 https://www.lumenmsp.co.uk/news/cyber-essentials-baseline/
Or call us on 0333 335 0170.

#CyberSecurity #Swindon #SmallBusiness`,
  },
  {
    slug: 'copilot-microsoft-365-smb',
    title: 'Microsoft Copilot opens up to small businesses',
    link: 'https://www.lumenmsp.co.uk/news/copilot-microsoft-365-smb/',
    linkedin: `Microsoft Copilot is now within reach of small businesses — but before you switch it on, ask one question: are your Microsoft 365 foundations ready for it?

Copilot is genuinely useful. Inside Word, Excel, Outlook and Teams it can draft documents, summarise long email threads, pull insights from spreadsheets and catch you up on meetings you missed. For a lean team, that's real time back.

The catch the marketing skips: Copilot draws on the data you already hold and respects your existing permissions. So if access has been left loose over the years — files shared too widely, old permissions never tidied — Copilot will efficiently surface things in front of people who were never meant to see them. It doesn't break your security model; it exposes it.

So the smart move is a bit of housekeeping first: tighten permissions, tidy your data, set a simple usage policy, then pilot it on the tasks where it'll actually save time.

We help businesses get the foundations right first — so AI delivers value, not a data-governance headache.

https://www.lumenmsp.co.uk/news/copilot-microsoft-365-smb/

#Microsoft365 #Copilot #AI #Productivity #ManagedIT`,
    facebook: `🤖 AI inside the apps your team already uses? That's Microsoft Copilot — now available to small businesses.

It can draft emails, summarise long threads, make sense of spreadsheets and catch you up on meetings. But there's a catch: it only works well (and safely) if your data and permissions are tidy first.

We get those foundations right so Copilot actually saves you time — without surfacing things it shouldn't.

Thinking about AI for your team? 👉 https://www.lumenmsp.co.uk/news/copilot-microsoft-365-smb/
Call us on 0333 335 0170.

#Microsoft365 #Swindon #SmallBusiness`,
  },
  {
    slug: 'pstn-switch-off-2027',
    title: "The PSTN switch-off is coming — here's what UK businesses need to know",
    link: 'https://www.lumenmsp.co.uk/news/pstn-switch-off-2027/',
    linkedin: `The PSTN switch-off is coming — and it's not just your office phones at stake.

By early 2027, the UK's old analogue and ISDN phone network is being switched off for good. Anything still running over copper has to move to digital calling first — and that includes a lot of things businesses forget are connected:

🔌 Card payment terminals
🔌 Door entry & intercoms
🔌 Alarm & CCTV signalling
🔌 Lift emergency lines

Leave it late and you're looking at rushed migrations, porting delays and downtime. Plan ahead and it's a genuine upgrade — lower call costs, work-from-anywhere flexibility, and one joined-up system with Microsoft Teams calling.

We migrate businesses off the old network every week and handle the whole journey, from auditing your lines to porting your numbers.

Still on analogue or ISDN? Now's the time to plan 👇
https://www.lumenmsp.co.uk/news/pstn-switch-off-2027/

#PSTNSwitchOff #VoIP #BusinessTelecoms #UKBusiness #ManagedIT`,
    facebook: `📞 The old phone network is being switched off by 2027 — is your business ready?

It's not just office phones. Card machines, door entry, alarms and lift lines can all rely on those old copper lines too. The good news: moving to internet-based calling is usually cheaper and far more flexible.

We handle the whole switch for you — including keeping your existing numbers. Get ahead of it and the change is smooth and stress-free.

Read what UK businesses need to know 👉 https://www.lumenmsp.co.uk/news/pstn-switch-off-2027/
Or give us a call on 0333 335 0170.

#Swindon #SmallBusiness #VoIP`,
  },
  {
    slug: 'mfa-best-defence',
    title: 'Multi-factor authentication: still your single best defence',
    link: 'https://www.lumenmsp.co.uk/news/mfa-best-defence/',
    linkedin: `If you do one thing to improve your security this year, do this: switch on multi-factor authentication everywhere.

Microsoft reports MFA blocks around 99% of automated account-takeover attacks. Very few security measures deliver that kind of return for so little cost — and it's often free with tools you already own.

Why it works: a password is a single secret, and single secrets leak — phished, breached, reused. MFA means a stolen password alone isn't enough to get in.

Where it matters most:
🔑 Email (the master key to everything else)
🔑 Microsoft 365 / Google Workspace
🔑 Finance & banking
🔑 Remote access / VPN
🔑 Admin accounts

The trick is rolling it out so it's secure *and* not painful — because security that gets in the way is security people work around.

Not sure MFA is on everywhere it should be? That's worth fixing today.

https://www.lumenmsp.co.uk/news/mfa-best-defence/

#MFA #CyberSecurity #InfoSec #UKBusiness #ManagedIT`,
    facebook: `🔒 Passwords get stolen — it's a fact of life. Multi-factor authentication (MFA) makes a stolen password almost useless to an attacker.

It's one of the cheapest, highest-impact security steps a business can take, and it blocks the vast majority of account attacks. The key is setting it up so it protects you without annoying your team.

Is yours switched on everywhere it should be? We can check 👉 https://www.lumenmsp.co.uk/news/mfa-best-defence/
Call us on 0333 335 0170.

#CyberSecurity #Swindon #SmallBusiness`,
  },
  {
    slug: 'microsoft-teams-phone',
    title: 'Microsoft Teams Phone: time to ditch the desk phone?',
    link: 'https://www.lumenmsp.co.uk/news/microsoft-teams-phone/',
    linkedin: `If your team already lives in Microsoft Teams, your next phone system might be sitting in front of you.

Teams Phone turns Teams into a full business phone system — make and take external calls, keep your existing numbers, and run voice, video and chat from one platform on any device. With the PSTN switch-off forcing everyone off the old copper network anyway, plenty of SMEs are folding the move into a tool they already own.

The upside:
📞 One platform instead of two
📞 Lower costs — fewer line rentals, no ageing phone hardware
📞 Add/remove users in clicks, not engineer visits
📞 Ideal for hybrid teams — your office number rings wherever you are

But it isn't right for everyone. A busy reception or contact-centre setup, lots of specialist handsets, or CRM integrations can point towards a dedicated hosted VoIP system instead. The right answer depends on how you actually work.

We assess that first, then recommend and deliver the right path — Teams Phone or VoIP — and handle the whole switch.

https://www.lumenmsp.co.uk/news/microsoft-teams-phone/

#TeamsPhone #Microsoft365 #VoIP #BusinessTelecoms #ManagedIT`,
    facebook: `☎️ Already use Microsoft Teams all day? You could turn it into your business phone system.

Teams Phone lets you make and take calls, keep your existing numbers, and run calls, chat and meetings all in one place — often cheaper and with less hardware to manage.

It's not right for every business though, so we give honest advice on whether Teams Phone or a hosted VoIP system suits you best.

Worth a look ahead of the PSTN switch-off 👉 https://www.lumenmsp.co.uk/news/microsoft-teams-phone/
Call us on 0333 335 0170.

#Swindon #SmallBusiness #VoIP`,
  },
  {
    slug: 'ransomware-backup-basics-2024',
    title: 'New year, new ransomware: getting backup and recovery right',
    link: 'https://www.lumenmsp.co.uk/news/ransomware-backup-basics-2024/',
    linkedin: `Ransomware is still the single biggest cyber threat to UK SMEs — and the thing that decides whether it's a disaster or just a bad day is your backups.

The foundation is the 3-2-1 rule:
📦 3 copies of your data
📦 on 2 different types of storage
📦 with 1 kept off-site or offline

That offline copy is the bit that defeats modern ransomware, because attackers deliberately hunt for and encrypt any backup they can reach over the network.

But here's the gap most businesses have: a backup you've never restored from is a hope, not a plan. Plenty of backups are quietly failing, or only cover the files and not the systems needed to use them. The only way to trust a backup is to test the restore — before you need it.

We design, monitor and regularly test backup systems built for fast recovery — so if the worst happens, you're back up in hours, not weeks.

Would your backups actually save you?
https://www.lumenmsp.co.uk/news/ransomware-backup-basics-2024/

#Ransomware #BackupAndRecovery #CyberSecurity #BusinessContinuity #ManagedIT`,
    facebook: `💾 Ransomware can freeze your entire business overnight — and good backups are what turn that catastrophe into a manageable inconvenience.

The golden rule is 3-2-1: three copies of your data, on two types of storage, with one kept offline. And crucially — a backup you've never tested is just a hope.

We set up, monitor AND test backups so you're genuinely protected.

Would yours actually work when it mattered? 👉 https://www.lumenmsp.co.uk/news/ransomware-backup-basics-2024/
Call us on 0333 335 0170.

#CyberSecurity #Swindon #SmallBusiness`,
  },
  {
    slug: 'cyber-essentials-2026-mfa-mandatory',
    title: 'Cyber Essentials just got stricter: MFA is now mandatory on every cloud service',
    link: 'https://www.lumenmsp.co.uk/news/cyber-essentials-2026-mfa-mandatory/',
    linkedin: `Cyber Essentials just got stricter — and it could catch a lot of UK businesses out.

The April 2026 update is now in force, and the headline change is blunt: multi-factor authentication is mandatory on every cloud service where it's available. Miss it on even one, and the whole certification auto-fails.

What changed:
🔐 MFA mandatory on all cloud services (auto-fail if missing)
☁️ "Cloud" now means anything staff log into with a work email — including free SaaS tiers
⏱️ Critical security patches must be applied within 14 days

With around 43% of UK businesses hit by a breach in the past year, this isn't red tape — MFA blocks the most common attack there is.

The tricky part is the wider scope: most businesses don't know every cloud app their team uses, and MFA is often left off on the "minor" ones.

We audit your cloud estate, switch on MFA properly, automate patching, and get you certified against the new standard.

Due to renew or certifying for the first time? Now's the time 👇
https://www.lumenmsp.co.uk/news/cyber-essentials-2026-mfa-mandatory/

#CyberEssentials #MFA #CyberSecurity #UKBusiness #ManagedIT`,
    facebook: `🔐 Heads up if your business uses Cyber Essentials — the rules just changed.

As of the April 2026 update, multi-factor authentication (MFA) is mandatory on every cloud service that offers it. Miss it on even one and the whole certification fails. "Cloud" now also covers the smaller apps your team logs into with a work email.

We audit your systems, switch on MFA without the headache, and get you certified under the new standard.

Renewing or certifying for the first time? 👉 https://www.lumenmsp.co.uk/news/cyber-essentials-2026-mfa-mandatory/
Or call us on 0333 335 0170.

#CyberSecurity #Swindon #SmallBusiness`,
  },
  {
    slug: 'disaster-recovery-testing',
    title: "Backups aren't enough — test your disaster recovery",
    link: 'https://www.lumenmsp.co.uk/news/disaster-recovery-testing/',
    linkedin: `Most businesses have backups. Far fewer have ever tested restoring from them — and that gap is exactly where disasters happen.

A backup you've never restored is an assumption, not a safeguard. Jobs fail silently for months; backups cover the files but not the systems needed to use them; nobody knows the recovery steps under pressure.

Real disaster recovery is about the whole picture:
🔁 How fast can critical systems come back?
🔁 In what order?
🔁 Do your people know what to do?

The only way to trust the plan is to test it before you need it.

We design, monitor and regularly test recovery — so "we have backups" becomes "we're back up in hours".

https://www.lumenmsp.co.uk/news/disaster-recovery-testing/

#DisasterRecovery #BusinessContinuity #CyberSecurity #ManagedIT`,
    facebook: `💽 Having backups isn't the same as being able to recover.

A backup you've never tested is a hope, not a plan — and plenty fail silently until the day you need them. Real disaster recovery means knowing how fast you can get critical systems back, and in what order.

We set up, monitor AND test recovery so you're covered when it counts.

👉 https://www.lumenmsp.co.uk/news/disaster-recovery-testing/
Call us on 0333 335 0170.

#CyberSecurity #Swindon #SmallBusiness`,
  },
  {
    slug: 'cloud-cost-control',
    title: 'Cloud cost control: getting real value from your subscriptions',
    link: 'https://www.lumenmsp.co.uk/news/cloud-cost-control/',
    linkedin: `Cloud spend has a habit of quietly creeping up — and a surprising chunk of it is usually wasted.

Unused licences, oversized services, forgotten subscriptions: across a year they add up fast. Industry studies consistently put a meaningful share of cloud spend in the "wasted" column.

The fix isn't to spend less on the cloud — it's to spend smarter. A regular review of licences, storage and services against what you actually use almost always uncovers real savings.

We run that review for clients and right-size what you're paying for — it often pays for itself many times over.

When did you last audit your cloud bill?
https://www.lumenmsp.co.uk/news/cloud-cost-control/

#CloudCost #Microsoft365 #ITStrategy #ManagedIT`,
    facebook: `☁️ Cloud costs creeping up? You're not alone — unused licences and forgotten subscriptions add up fast.

The answer isn't to cut the cloud, it's to spend smarter. A regular review of what you're actually using usually turns up real savings.

We'll right-size your cloud so you only pay for what you need.

👉 https://www.lumenmsp.co.uk/news/cloud-cost-control/
Call us on 0333 335 0170.

#Microsoft365 #Swindon #SmallBusiness`,
  },
  {
    slug: 'ai-phishing-staff-training',
    title: 'Phishing in the age of AI: your team is the front line',
    link: 'https://www.lumenmsp.co.uk/news/ai-phishing-staff-training/',
    linkedin: `Phishing has always relied on human error — and AI is making the bait far more convincing.

The old tell-tale signs (poor grammar, clumsy phrasing) are disappearing fast. Today's scam emails can be polished, personalised and genuinely hard to spot — and AI-crafted ones get clicked far more often than the old kind.

Technology helps: spam filtering, MFA and endpoint protection all matter. But your people remain the front line, and regular, practical awareness training is one of the highest-return security investments a business can make.

We run staff awareness training and simulated phishing that builds a real instinct for spotting the bait.

https://www.lumenmsp.co.uk/news/ai-phishing-staff-training/

#Phishing #SecurityAwareness #CyberSecurity #ManagedIT`,
    facebook: `🎣 AI is making scam emails scarily convincing — the bad grammar that used to give them away is gone.

Good filters and MFA help, but your team is the front line. A bit of regular awareness training is one of the best-value security steps you can take.

We train staff to spot the bait before it costs you.

👉 https://www.lumenmsp.co.uk/news/ai-phishing-staff-training/
Call us on 0333 335 0170.

#CyberSecurity #Swindon #SmallBusiness`,
  },
  {
    slug: 'securing-ai-2026',
    title: 'Securing AI: the new risks every business should know in 2026',
    link: 'https://www.lumenmsp.co.uk/news/securing-ai-2026/',
    linkedin: `As AI tools become part of everyday work, they bring new security questions worth getting ahead of.

The big three: staff pasting sensitive data into public AI tools, AI-generated content being trusted too readily, and attackers using AI to craft sharper scams. Analysts now rank AI-related risk among the top security concerns for the year.

The good news? The defences are largely familiar — clear usage policies, sensible data handling, MFA and awareness. The principles haven't changed, even if the tools have.

We help businesses adopt AI safely: simple guardrails that let your team get the benefits without the risks.

https://www.lumenmsp.co.uk/news/securing-ai-2026/

#AISecurity #CyberSecurity #Microsoft365 #ManagedIT`,
    facebook: `🤖 Using AI tools at work? They bring real benefits — and a few new risks, like staff pasting sensitive info into public chatbots.

The good news: the defences are familiar — a simple usage policy, sensible data handling and MFA go a long way.

We help you adopt AI safely.

👉 https://www.lumenmsp.co.uk/news/securing-ai-2026/
Call us on 0333 335 0170.

#CyberSecurity #Swindon #SmallBusiness`,
  },
  {
    slug: 'multi-cloud-resilience-2026',
    title: 'Multi-cloud and resilience: lessons from a year of outages',
    link: 'https://www.lumenmsp.co.uk/news/multi-cloud-resilience-2026/',
    linkedin: `After a run of high-profile outages, resilience has climbed every IT agenda — but you don't need enterprise-scale complexity to benefit from the lesson.

For the biggest organisations, multi-region and multi-cloud strategies make sense. For most SMEs, full multi-cloud is overkill. The real point isn't complexity for its own sake — it's knowing your critical dependencies and having a plan for when one of them fails.

Which systems must stay up? What happens if your main provider has a bad day? Can you keep serving customers in the meantime?

We map those dependencies and build right-sized resilience — practical, not over-engineered.

https://www.lumenmsp.co.uk/news/multi-cloud-resilience-2026/

#Resilience #BusinessContinuity #Cloud #ManagedIT`,
    facebook: `🌐 A year of big outages taught everyone the same lesson: know what you'd do if a key system went down.

You don't need enterprise-grade complexity — just a clear view of your critical dependencies and a plan for when one fails.

We build right-sized resilience for SMEs.

👉 https://www.lumenmsp.co.uk/news/multi-cloud-resilience-2026/
Call us on 0333 335 0170.

#Swindon #SmallBusiness #Cloud`,
  },
  {
    slug: 'ai-agents-workplace-2026',
    title: 'AI agents in the workplace: hype versus help for SMEs',
    link: 'https://www.lumenmsp.co.uk/news/ai-agents-workplace-2026/',
    linkedin: `"AI agents" are the phrase on every vendor's lips this year — software that doesn't just answer questions but carries out multi-step tasks for you. The potential is real, but the hype is running well ahead of most real-world results.

For SMEs, the sensible approach is to ignore the buzzwords and ask one plain question: what repetitive, time-consuming task would you most like to hand off?

Start there, with something small and measurable, rather than chasing the shiniest demo. The wins come from solving a real problem — not adopting "agentic AI" because it's trending.

We help businesses cut through the noise and apply AI where it actually saves time.

https://www.lumenmsp.co.uk/news/ai-agents-workplace-2026/

#AI #Productivity #Microsoft365 #ManagedIT`,
    facebook: `🤖 "AI agents" are everywhere this year — but the hype is well ahead of reality.

For most small businesses the smart move is simple: ignore the buzzwords and ask what repetitive task you'd most like to hand off. Start there.

We help you apply AI where it genuinely saves time.

👉 https://www.lumenmsp.co.uk/news/ai-agents-workplace-2026/
Call us on 0333 335 0170.

#Swindon #SmallBusiness #AI`,
  },
  {
    slug: 'windows-10-end-of-life-today',
    title: 'Windows 10 reaches end of life today',
    link: 'https://www.lumenmsp.co.uk/news/windows-10-end-of-life-today/',
    linkedin: `Still running Windows 10? It's now past end of support — and that matters more every week.

Microsoft ended free security updates for Windows 10 on 14 October 2025. Machines still on it no longer get patches, so the risk of using them grows with every passing month. Unsupported systems shouldn't be touching anything sensitive.

If you've upgraded already, well done. If not, don't panic — but do act. The right approach is a clear plan: audit your devices, identify which can move to Windows 11 and which need replacing, and stage the work.

We handle the whole upgrade — assessment, hardware, migration — with minimal disruption.

https://www.lumenmsp.co.uk/news/windows-10-end-of-life-today/

#Windows10 #Windows11 #ITSupport #ManagedIT`,
    facebook: `🖥️ Still on Windows 10? It's now past end of support — no more security updates, and the risk grows every month.

No need to panic, but it's time to act: a clear plan to move eligible machines to Windows 11 and replace the rest.

We handle the whole upgrade with minimal disruption.

👉 https://www.lumenmsp.co.uk/news/windows-10-end-of-life-today/
Call us on 0333 335 0170.

#Swindon #SmallBusiness #ITSupport`,
  },
  {
    slug: 'cyber-essentials-renewal',
    title: "Cyber Essentials renewal season: don't let your badge lapse",
    link: 'https://www.lumenmsp.co.uk/news/cyber-essentials-renewal/',
    linkedin: `Cyber Essentials certification lasts a year — and renewal is more than a formality.

Your IT estate changes, new devices and apps appear, and the threat landscape never stands still. Annual recertification keeps your protections current rather than frozen at a single point in time. And with the scheme's 2026 update bringing mandatory MFA on all cloud services, this year's renewal carries real new requirements.

Letting it lapse can cost you, too: more contracts and supply chains now require valid certification as a condition of doing business.

We manage renewals end to end — including the new rules — so your badge keeps reflecting real protection.

Is yours due?
https://www.lumenmsp.co.uk/news/cyber-essentials-renewal/

#CyberEssentials #CyberSecurity #UKBusiness #ManagedIT`,
    facebook: `🔐 Cyber Essentials is annual for a reason — your IT and the threats both change through the year.

With the 2026 update bringing mandatory MFA on cloud services, this year's renewal has real new requirements. Let it lapse and you could lose contracts that require it.

We manage renewals end to end.

👉 https://www.lumenmsp.co.uk/news/cyber-essentials-renewal/
Call us on 0333 335 0170.

#CyberSecurity #Swindon #SmallBusiness`,
  },
  {
    slug: 'uk-retail-ransomware-wave',
    title: 'Ransomware hits the UK high street: M&S, Co-op and Harrods',
    link: 'https://www.lumenmsp.co.uk/news/uk-retail-ransomware-wave/',
    linkedin: `When ransomware hit M&S, Co-op and Harrods, it was a stark reminder: size is no protection.

Those attacks disrupted operations, online orders and, in some cases, customer data — with the financial hit running into the hundreds of millions. And the way in often wasn't brute force; it was people and suppliers, with social engineering of IT help desks reported as a route in.

The lesson for every business: attackers target the human layer and the supply chain, not just your firewall. Strong technical controls matter — but so do staff awareness, tight access, and a tested recovery plan.

We build that layered defence for SMEs — because you don't have to be a household name to be a target.

https://www.lumenmsp.co.uk/news/uk-retail-ransomware-wave/

#Ransomware #CyberSecurity #SupplyChain #ManagedIT`,
    facebook: `🛒 Ransomware hit M&S, Co-op and Harrods — proof that no business is too big (or too small) to be a target.

Attackers often get in through people and suppliers, not brute force. The defence is layered: staff awareness, tight access and a tested recovery plan.

We build that for SMEs.

👉 https://www.lumenmsp.co.uk/news/uk-retail-ransomware-wave/
Call us on 0333 335 0170.

#CyberSecurity #Swindon #SmallBusiness`,
  },
  {
    slug: 'crowdstrike-global-outage',
    title: 'The CrowdStrike outage: how one update grounded the world',
    link: 'https://www.lumenmsp.co.uk/news/crowdstrike-global-outage/',
    linkedin: `The CrowdStrike outage grounded flights, froze hospitals and took down millions of Windows machines worldwide — and it wasn't even a cyberattack. It was a botched update to trusted software.

Around 8.5 million devices went into a continuous "blue screen" all at once. The lesson isn't "distrust your security tools" — it's that resilience matters as much as prevention. One bad update, one provider's bad day, can hit everyone who depends on them.

So plan for it: know your critical dependencies, control how updates roll out, and have a way to keep operating when something upstream breaks.

We help SMEs build that resilience — sensible, not paranoid.

https://www.lumenmsp.co.uk/news/crowdstrike-global-outage/

#Resilience #ITOutage #BusinessContinuity #ManagedIT`,
    facebook: `💻 The CrowdStrike outage took down millions of computers worldwide — and it wasn't a hack, just a bad software update.

The takeaway: resilience matters as much as prevention. Know your critical systems and have a plan for when something upstream breaks.

We help SMEs build sensible resilience.

👉 https://www.lumenmsp.co.uk/news/crowdstrike-global-outage/
Call us on 0333 335 0170.

#Swindon #SmallBusiness #ITSupport`,
  },
];

// Each seeded article reuses its public website image (already hosted at lumenmsp.co.uk).
const IMG_BASE = 'https://www.lumenmsp.co.uk/images/news/';
const SLUG_IMAGE: Record<string, string> = {
  'cyber-essentials-baseline': IMG_BASE + 'security-lock.jpg',
  'copilot-microsoft-365-smb': IMG_BASE + 'email.jpg',
  'pstn-switch-off-2027': IMG_BASE + 'fibre.jpg',
  'mfa-best-defence': IMG_BASE + 'security-lock.jpg',
  'microsoft-teams-phone': IMG_BASE + 'comms.jpg',
  'ransomware-backup-basics-2024': IMG_BASE + 'datacenter.jpg',
  'cyber-essentials-2026-mfa-mandatory': IMG_BASE + 'security-lock.jpg',
  'disaster-recovery-testing': IMG_BASE + 'datacenter.jpg',
  'cloud-cost-control': IMG_BASE + 'cloud.jpg',
  'ai-phishing-staff-training': IMG_BASE + 'security.jpg',
  'securing-ai-2026': IMG_BASE + 'security.jpg',
  'multi-cloud-resilience-2026': IMG_BASE + 'cloud2.jpg',
  'ai-agents-workplace-2026': IMG_BASE + 'ai2.jpg',
  'windows-10-end-of-life-today': IMG_BASE + 'devices.jpg',
  'cyber-essentials-renewal': IMG_BASE + 'security-lock.jpg',
  'uk-retail-ransomware-wave': IMG_BASE + 'security.jpg',
  'crowdstrike-global-outage': IMG_BASE + 'datacenter.jpg',
};

export async function seedSocialPosts(): Promise<void> {
  // Idempotent per-slug: inserts any SEED article not already present, so new posts added to
  // SEED appear on the next deploy without disturbing existing rows.
  for (const a of SEED) {
    const ex = await pool.query(`SELECT 1 FROM social_posts WHERE slug=$1 LIMIT 1`, [a.slug]);
    if (ex.rows.length) continue;
    const img = SLUG_IMAGE[a.slug] || null;
    const variants: Array<[string, string]> = [
      ['linkedin', a.linkedin],
      ['facebook', a.facebook],
      ['google', stripHashtags(a.facebook)],
    ];
    for (const [network, body] of variants) {
      await pool.query(
        `INSERT INTO social_posts (slug, title, link, network, body, kind, image_url) VALUES ($1,$2,$3,$4,$5,'news',$6)`,
        [a.slug, a.title, a.link, network, body, img]);
    }
  }
}

// Backfill images on rows that pre-date the image_url column (idempotent).
export async function backfillImages(): Promise<void> {
  for (const [slug, url] of Object.entries(SLUG_IMAGE)) {
    await pool.query(
      `UPDATE social_posts SET image_url=$1 WHERE slug=$2 AND (image_url IS NULL OR image_url='')`,
      [url, slug]);
  }
}

// Set (or clear) the image for every channel variant of an article.
export async function setArticleImage(slug: string, imageUrl: string | null): Promise<void> {
  await pool.query(`UPDATE social_posts SET image_url=$1 WHERE slug=$2`, [imageUrl || null, slug]);
}

export async function listPosts(): Promise<SocialPostRow[]> {
  const { rows } = await pool.query(`SELECT * FROM social_posts WHERE active=true ORDER BY kind, slug, network`);
  return rows;
}

export async function getPostsByIds(ids: number[]): Promise<SocialPostRow[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query(`SELECT * FROM social_posts WHERE id = ANY($1::bigint[])`, [ids]);
  return rows;
}

export async function addAdhocPost(title: string, link: string, networks: string[], body: string, imageUrl?: string): Promise<void> {
  const slug = 'adhoc-' + Date.now();
  for (const network of networks) {
    const text = network === 'google' ? stripHashtags(body) : body;
    await pool.query(
      `INSERT INTO social_posts (slug, title, link, network, body, kind, image_url) VALUES ($1,$2,$3,$4,$5,'adhoc',$6)`,
      [slug, title || 'Ad-hoc update', link || null, network, text, imageUrl || null]);
  }
}

export async function deletePost(id: number): Promise<void> {
  await pool.query(`UPDATE social_posts SET active=false WHERE id=$1`, [id]);
}

// Bulk-archive (hide from the active list) — used once a batch has been scheduled/sent.
export async function archivePosts(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await pool.query(`UPDATE social_posts SET active=false WHERE id = ANY($1::bigint[])`, [ids]);
}

// ── Content studio + archive management ─────────────────────────────────────────
// Save the 4 generated pieces (per-network copy + the website article markdown) as one topic.
export async function saveStudioPosts(input: {
  topic: string; relevanceDate: string | null; link: string | null; imageUrl: string | null;
  linkedin: string; facebook: string; google: string; website: string;
}): Promise<string> {
  const slug = 'created-' + Date.now();
  const title = (input.topic || 'New post').trim().slice(0, 200) || 'New post';
  const rel = input.relevanceDate || null;
  const rows: Array<[string, string]> = [
    ['linkedin', input.linkedin], ['facebook', input.facebook],
    ['google', input.google], ['website', input.website], // website body = ready-to-paste Astro markdown
  ];
  for (const [network, body] of rows) {
    if (!body || !body.trim()) continue;
    await pool.query(
      `INSERT INTO social_posts (slug, title, link, network, body, kind, image_url, relevance_date)
       VALUES ($1,$2,$3,$4,$5,'created',$6,$7)`,
      [slug, title, input.link || null, network, body, input.imageUrl || null, rel]);
  }
  return slug;
}

// Archived (active=false) posts — manually archived or auto-archived after a successful push.
export async function listArchived(limit = 120): Promise<SocialPostRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM social_posts WHERE active=false
      ORDER BY COALESCE(relevance_date, created_at::date) DESC, slug, network LIMIT $1`, [limit]);
  return rows;
}

export async function restorePosts(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await pool.query(`UPDATE social_posts SET active=true WHERE id = ANY($1::bigint[])`, [ids]);
}

// Whole-topic (slug) archive / restore / relevance-date override — used by the per-card buttons.
export async function archiveBySlug(slug: string): Promise<void> {
  await pool.query(`UPDATE social_posts SET active=false WHERE slug=$1`, [slug]);
}
export async function restoreBySlug(slug: string): Promise<void> {
  await pool.query(`UPDATE social_posts SET active=true WHERE slug=$1`, [slug]);
}
export async function setRelevanceDate(slug: string, date: string | null): Promise<void> {
  await pool.query(`UPDATE social_posts SET relevance_date=$1 WHERE slug=$2`, [date || null, slug]);
}

// Post rows that have already gone out cleanly (a successful Buffer push) — hidden from the
// "to schedule" list so sent posts don't clutter it even if not yet archived.
export async function sentPostIds(): Promise<Set<number>> {
  const { rows } = await pool.query(`SELECT DISTINCT post_id FROM social_uploads WHERE status='ok' AND post_id IS NOT NULL`);
  return new Set<number>(rows.map((r: any) => Number(r.post_id)));
}

export async function recordUpload(u: {
  postId?: number | null; slug?: string | null; network: string; action: string; status: string;
  bufferPostId?: string | null; dueAt?: string | null; message?: string | null; createdBy?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO social_uploads (post_id, slug, network, action, status, buffer_post_id, due_at, message, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [u.postId ?? null, u.slug ?? null, u.network, u.action, u.status, u.bufferPostId ?? null, u.dueAt ?? null, u.message ?? null, u.createdBy ?? null]);
}

export async function listUploads(limit = 100): Promise<any[]> {
  const { rows } = await pool.query(`SELECT * FROM social_uploads ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows;
}

// ---------- scheduling (mirrors the standalone buffer-push tool) ----------
const TIMES: Record<string, string> = { linkedin: '09:00', facebook: '12:00', google: '13:00' };
const OFFSET = '+01:00'; // UK BST; switch to +00:00 in winter
const ORDER = [
  'cyber-essentials-baseline', 'copilot-microsoft-365-smb', 'pstn-switch-off-2027',
  'mfa-best-defence', 'microsoft-teams-phone', 'ransomware-backup-basics-2024',
];

function weekdayDates(count: number, startStr?: string): string[] {
  let d: Date;
  if (startStr && /^\d{4}-\d{2}-\d{2}$/.test(startStr)) {
    const [y, m, dd] = startStr.split('-').map(Number);
    d = new Date(Date.UTC(y, m - 1, dd, 12));
  } else {
    const n = new Date();
    d = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), 12));
  }
  const out: string[] = [];
  while (out.length < count) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

function dueAtFor(dateStr: string, network: string): string {
  const time = TIMES[network] || '09:00';
  let iso = new Date(`${dateStr}T${time}:00${OFFSET}`).toISOString();
  if (new Date(iso).getTime() <= Date.now()) {
    const stagger = network === 'linkedin' ? 5 : network === 'facebook' ? 10 : 15;
    iso = new Date(Date.now() + stagger * 60000).toISOString();
  }
  return iso;
}

// One weekday per article (calendar order), all its channel-posts share that date.
export function assignSchedule(posts: SocialPostRow[], startStr?: string): Map<number, string> {
  const slugs = [...new Set(posts.map((p) => p.slug))];
  const ordered = [...ORDER.filter((s) => slugs.includes(s)), ...slugs.filter((s) => !ORDER.includes(s))];
  const dates = weekdayDates(ordered.length, startStr);
  const dateForSlug: Record<string, string> = {};
  ordered.forEach((s, i) => { dateForSlug[s] = dates[i]; });
  const map = new Map<number, string>();
  for (const p of posts) map.set(p.id, dueAtFor(dateForSlug[p.slug], p.network));
  return map;
}

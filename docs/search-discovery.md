# Search and AI discovery

The public site uses `https://juiced.codes` as its canonical origin. Public
pages have their own title, description, canonical URL, Open Graph metadata,
and Twitter card. The shared social image is generated locally by Next.js;
it does not fetch fonts or images from an external service.

## Public content

- `/docs` links to five server-rendered guides: getting started, workspaces and
  sessions, code transfers, remote Claude Code, and Juiced versus a VPS.
- `/pricing` describes Free (10 vCPU hours) and Unlimited ($25/month). Both
  include all features. One vCPU hour is one virtual CPU running for one hour.
  Pricing copy does not configure service entitlements or Stripe billing.
- `/sitemap.xml` includes only the homepage, docs index, guides, and pricing.
  Add new public pages here when they ship. Do not add account or API routes.
- `/robots.txt` advertises the sitemap and permits public crawlers, including AI
  search crawlers. Sign-in, account, and device HTML may be crawled so bots can
  read their `X-Robots-Tag: noindex, nofollow` response headers. API, webhook, and
  health routes remain disallowed. Authentication protects account data.
- `/llms.txt` is a human-readable documentation index with product facts. Keep
  it aligned with public content when commands, pricing, or behavior change.
- The homepage contains `WebSite` and `SoftwareApplication` JSON-LD matching
  visible product facts. There are no fabricated reviews, ratings, or purchase
  offers. This does not claim eligibility for a particular search rich result.

The known public alias `juiced-eight.vercel.app` redirects permanently to the
canonical host, preserving paths, queries, and HTTP methods. `/api/`, `/v1/`, and
`/webhooks/` are not redirected because cron, queue, Stripe, and CLI callers do
not follow redirects. Other Vercel hosts and localhost are not redirected. OAuth callbacks should use the canonical
origin, as documented in the managed-service setup.

## Verify ownership after deployment

1. Add `juiced.codes` in [Google Search Console](https://search.google.com/search-console).
   A Domain property needs DNS verification. Alternatively, add the URL-prefix
   property `https://juiced.codes/` and choose HTML-tag verification.
2. For HTML-tag verification, set `GOOGLE_SITE_VERIFICATION` in the Vercel
   project's build environment to the tag's `content` value, not the whole tag.
   Redeploy, confirm `google-site-verification` in the rendered HTML, and verify.
3. Add the site in [Bing Webmaster Tools](https://www.bing.com/webmasters/), or
   import the verified Search Console property. For Bing's HTML-tag method,
   set `BING_SITE_VERIFICATION` to the `msvalidate.01` tag's `content` value and
   redeploy. Verification tokens are public; do not use account credentials here.
4. Submit `https://juiced.codes/sitemap.xml` in both tools. Use Google's URL
   Inspection live test on the homepage, a guide, and pricing. Request indexing
   for the new pages. Confirm the selected canonical after Google has crawled.
5. Connect the verified Juiced property to a Juiced-specific OpenSEO project if
   reporting there. Do not replace the existing Cantelop property's binding.

Metadata is built with the site. Adding or changing either verification token
requires a new deployment. A valid sitemap and verification do not guarantee
indexing. The connected Search Console account inspected on October 21, 2026
exposed a verified Cantelop property but no Juiced property; ownership verification
and sitemap submission remain external rollout steps.

## Establish a measured baseline

Before these changes, live checks on October 21, 2026 found:

| Check | Observation |
| --- | --- |
| Homepage | HTTP 200; prerendered product text, title, description, and favicon |
| Public crawl policy | Homepage allowed by the wildcard robots rule |
| Sitemap, docs, pricing, LLM index | HTTP 404 for `/sitemap.xml`, `/docs`, `/pricing`, `/llms.txt` |
| Canonical and sharing tags | No canonical link, Open Graph, or Twitter card in homepage HTML |
| Vercel alias | HTTP 200; same main content as the custom domain, no canonical link |
| Search indexing, clicks, impressions | Unknown; no verified Juiced Search Console property available |
| AI mentions and citations | Not measured; no paid answer collection was started |

After deployment and verification, record the deployment revision, date, indexed
URLs, clicks, impressions, queries, and landing pages from Search Console and
Bing. Use complete, comparable periods (for example, the last 28 days) and label
missing data as unknown rather than zero. These tools do not provide a universal
measure of AI visibility.

For an initial AI citation baseline, use a fixed set of neutral questions:

1. How can I keep Claude Code running when I close my laptop?
2. How can I run Claude Code in the cloud from my terminal?
3. What tools provide persistent cloud workspaces for Claude Code?
4. How do I detach from a Claude Code session and reconnect later?
5. How can I review cloud coding agent changes before applying them locally?
6. What are the options for running Claude Code on a VPS?
7. How can I isolate Claude Code projects in separate cloud workspaces?
8. How can I move a local Git project into a remote Claude Code workspace?
9. Can I bring my own Claude Code login to a cloud workspace?
10. How do I stop paying for idle compute when running a coding agent remotely?

Log the engine/product, question, date, country/language, answer, brands mentioned,
and exact cited URLs. Keep branded questions separate. Count failures separately
from answered questions that omit Juiced. A small sample is directional; an API
answer is not evidence of what every user sees in the consumer product. Any paid
collection or recurring tracking needs a separate approved cost estimate.

## Deployment checks

Run `npm run check:service`, `npm run test:service`, and `npm run build:service`.
Start the production build with `npm run start:service` and check:

- Every sitemap URL returns 200 and contains its own canonical URL and title.
- Guides and pricing are readable in the original HTML without JavaScript.
- Internal public links resolve, and an unknown guide returns a real 404.
- `/opengraph-image` returns a 1200 by 630 PNG; preview the image visually.
- A request with host `juiced-eight.vercel.app` redirects to the custom domain
  with its path and query intact, except API, `/v1/`, and webhook paths. Local
  and preview hosts continue working.
- Sign-in/account/device responses carry `noindex`; public pages do not.
- Sitemap and `llms.txt` contain only public canonical links.

The installer is a separate work item. These changes do not alter its command,
delivery, or release process. Publishing these pages, submitting the sitemap,
and verifying ownership happen after the branch is merged and deployed.

References: [Google AI search guidance](https://developers.google.com/search/docs/appearance/ai-features),
[OpenAI crawlers](https://developers.openai.com/api/docs/bots), and
[Claude Code authentication](https://code.claude.com/docs/en/authentication).
Google AI search requires no special AI files or markup. OpenAI's search crawler
and training crawler have independent controls. An LLM documentation index is a
convenience for tools that use it, not a ranking or citation guarantee.

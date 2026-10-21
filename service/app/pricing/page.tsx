import { PublicPage } from '../site-components';
import { pageMetadata } from '../../src/site';

const description =
  'All Juiced features on both plans. Start with 100 hours of free compute, or get more compute for $25 per month. Bring your own Claude Code access.';
export const metadata = pageMetadata(
  'Pricing and availability',
  description,
  '/pricing',
);

export default function Pricing() {
  return (
    <PublicPage
      title="All the features. Choose your compute."
      intro="Both plans include everything Juiced provides. Claude Code access is separate."
    >
      <div className="pricing-grid">
        <section className="pricing-card" aria-labelledby="free-plan">
          <h2 id="free-plan">Free</h2>
          <p className="price">$0</p>
          <p>100 hours of cloud compute.</p>
          <ul>
            <li>All Juiced features</li>
            <li>Persistent project workspaces</li>
            <li>Detach and reconnect to sessions</li>
            <li>Explicit code transfers and local review</li>
          </ul>
        </section>
        <section className="pricing-card" aria-labelledby="paid-plan">
          <h2 id="paid-plan">More compute</h2>
          <p className="price">
            $25 <span>/ month</span>
          </p>
          <p>More cloud compute, with all Juiced features.</p>
          <ul>
            <li>Everything in Free</li>
            <li>A larger compute allowance</li>
          </ul>
          <p className="pricing-note">
            The paid compute allowance is still being finalized.
          </p>
        </section>
      </div>
      <h2>Availability</h2>
      <p>
        Managed access is in preview. These are the planned tiers; free-tier
        enrollment and paid checkout are not generally available yet.
      </p>
      <p>
        The free plan’s allowance period and the paid plan’s compute limit will
        be published here when confirmed.
      </p>
      <h2>Bring your own Claude Code access</h2>
      <p>
        Juiced provides the cloud workspace and compute. Your Claude account and
        model usage are separate. Sign in to Claude inside your workspace using
        an account with Claude Code access.
      </p>
      <h2>What persists?</h2>
      <p>
        Your code, Claude login, and saved conversations remain in the workspace
        between runs. The sandbox shuts down when idle. Read about{' '}
        <a href="/docs/workspaces-and-sessions">workspaces and sessions</a> for
        how persistence and reconnection work.
      </p>
      <p>
        <a href="/docs/getting-started">Read the setup guide</a> or{' '}
        <a href="https://github.com/stepandel/juiced">view Juiced on GitHub</a>.
      </p>
    </PublicPage>
  );
}

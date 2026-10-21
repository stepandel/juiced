import { PublicPage } from '../site-components';
import { pageMetadata } from '../../src/site';

const description =
  'Every Juiced feature on both plans. Free includes 10 vCPU hours. Get unlimited compute for $25 per month. Claude Code access is separate.';
export const metadata = pageMetadata('Pricing', description, '/pricing');

export default function Pricing() {
  return (
    <PublicPage
      title="Simple pricing."
      intro="Every feature, on both plans."
      eyebrow={{ label: 'Pricing', href: '/pricing' }}
    >
      <div className="pricing-grid">
        <section className="pricing-card" aria-labelledby="free-plan">
          <h2 id="free-plan">Free</h2>
          <p className="price">$0</p>
          <p>10 vCPU hours.</p>
        </section>
        <section className="pricing-card" aria-labelledby="paid-plan">
          <h2 id="paid-plan">Unlimited</h2>
          <p className="price">
            $25 <span>/ month</span>
          </p>
          <p>Unlimited compute.</p>
        </section>
      </div>
      <p className="pricing-details">
        One vCPU hour is one virtual CPU running for one hour. Claude Code
        access is separate.
      </p>
      <p>
        <a href="/docs/getting-started">Get started</a>
      </p>
    </PublicPage>
  );
}

export default function Offline() {
  return <main id="main" className="offline-page">
    <a className="brand" href="/">Money Coach<span className="brand-dot" /></a>
    <section>
      <h1>A little pause.<br />Your plan can wait.</h1>
      <p>You’re offline. Connect to refresh your financial information and continue your plan.</p>
      <a className="button" href="/">Try connecting again</a>
    </section>
    <section className="learning-note">
      <h2>A buffer gives you breathing room</h2>
      <p>A safety buffer is money you keep aside for uncertainty. It is separate from bills you already expect and savings you have promised to a goal.</p>
      <p>When you reconnect, Money Coach can review the latest information before estimating what is available for spending or saving.</p>
    </section>
    <p className="muted">Public learning content. Personal balances and financial results are not stored for offline use.</p>
  </main>;
}

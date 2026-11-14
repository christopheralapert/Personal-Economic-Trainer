import './styles.css'

const transactions = [
  { date: '28 Feb', merchant: 'S-market Ruoholahti', category: 'Groceries', amount: -42.8 },
  { date: '27 Feb', merchant: 'HSL Helsinki', category: 'Transport', amount: -3.2 },
  { date: '25 Feb', merchant: 'Palkka', category: 'Income', amount: 2710 },
  { date: '23 Feb', merchant: 'Wolt', category: 'Dining out', amount: -23.5 },
  { date: '21 Feb', merchant: 'Helen electricity', category: 'Home', amount: -67.4 },
  { date: '18 Feb', merchant: 'K-Market Kamppi', category: 'Groceries', amount: -18.9 },
  { date: '15 Feb', merchant: 'Netflix.com', category: 'Subscriptions', amount: -13.99 },
  { date: '12 Feb', merchant: 'R-kioski', category: 'Everyday', amount: -6.8 },
  { date: '07 Feb', merchant: 'Restaurant Nokka', category: 'Dining out', amount: -46.2 },
]

const money = (value) => new Intl.NumberFormat('fi-FI', { style: 'currency', currency: 'EUR' }).format(value)
const spend = transactions.filter((tx) => tx.amount < 0).reduce((sum, tx) => sum + Math.abs(tx.amount), 0)
const dining = transactions.filter((tx) => tx.category === 'Dining out').reduce((sum, tx) => sum + Math.abs(tx.amount), 0)
const monthData = {
  February: { label: '1-28 Feb', available: 1874.32, spent: spend, safe: 118, width: 69 },
  January: { label: '1-31 Jan', available: 2018.64, spent: 532.18, safe: 132, width: 76 },
}
const categoryTotals = ['Groceries', 'Dining out', 'Home', 'Transport'].map((category) => ({
  category,
  value: transactions.filter((tx) => tx.category === category).reduce((sum, tx) => sum + Math.abs(tx.amount), 0),
}))
const answers = {
  'How much did I spend on taxis last month?': 'There are no taxi transactions in this demo month. Your transport spend was 3.20 EUR, all on HSL.',
  'What kind of spender am I?': `You look fairly intentional: ${Math.round((categoryTotals[0].value / spend) * 100)}% of tracked spending went to groceries and home essentials. Dining out was ${money(dining)}.`,
  'What is safe for me to spend this week?': 'Based on this demo slice, 118 EUR is a cautious weekly ceiling after setting aside recurring home costs. Treat it as guidance, not a promise.',
}
const answerFor = (question) => {
  const normalized = question.toLowerCase()
  if (normalized.includes('grocery') || normalized.includes('groceries')) return `You spent ${money(categoryTotals.find((item) => item.category === 'Groceries').value)} on groceries in this demo month.`
  if (normalized.includes('dining') || normalized.includes('restaurant') || normalized.includes('wolt')) return `Dining out came to ${money(dining)} across two transactions. A 20% reduction would return ${money(dining * .2)}.`
  if (normalized.includes('subscription')) return 'Your tracked subscriptions came to 13.99 EUR, from Netflix.com.'
  if (normalized.includes('income') || normalized.includes('salary') || normalized.includes('palkka')) return 'Your tracked income this month is 2,710.00 EUR from Palkka.'
  return answers[question] ?? 'I can help with spending, categories, recurring costs, and simple what-if scenarios. Try asking how much you spent on groceries or dining out.'
}
const loadLocal = (key, fallback) => { try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value) } catch { return fallback } }
const saveLocal = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private browsing can disable storage */ } }
const basketData = [
  { key: 'regular', label: 'Regular essentials', amount: 85.4, tone: 'coral', text: 'The bills that keep life running: home, subscriptions, and transport.' },
  { key: 'irregular', label: 'Unexpected', amount: 0, tone: 'lilac', text: 'No unusual one-off purchases showed up in this demo month.' },
  { key: 'everyday', label: 'Everyday spending', amount: 92.2, tone: 'sage', text: 'The small choices that add up: groceries, dining out, and quick stops.' },
]
const recurring = [
  { name: 'Helen electricity', detail: 'Home · usually around the 21st', amount: 67.4 },
  { name: 'Netflix.com', detail: 'Subscription · usually around the 15th', amount: 13.99 },
]

function transactionMarkup(tx) {
  const iconClass = tx.category.toLowerCase().replaceAll(' ', '-')
  return `<button class="transaction" data-merchant="${tx.merchant}" data-category="${tx.category}" data-date="${tx.date}" data-amount="${tx.amount}"><div class="merchant-icon ${iconClass}">${tx.category === 'Income' ? '+' : tx.merchant.charAt(0)}</div><div class="transaction-copy"><strong>${tx.merchant}</strong><span>${tx.category} - ${tx.date}</span></div><b class="amount ${tx.amount > 0 ? 'positive' : ''}">${tx.amount > 0 ? '+' : ''}${money(tx.amount)}</b><span class="transaction-arrow">-></span></button>`
}

function render() {
  document.querySelector('#app').innerHTML = `
    <div class="shell">
      <header class="topbar"><a class="brand" href="#top" aria-label="Oma raha home"><span class="brand-mark">o</span><span>oma raha</span></a><div class="topbar-actions"><button class="install-app" id="install-app" hidden>Install app</button><button class="update-notice" id="update-notice" hidden>Update ready</button><span class="connection-status" id="connection-status"><span class="status-dot"></span><span>Ready offline</span></span><button class="avatar" id="avatar" aria-label="Open profile">A</button></div></header>
      <main id="top">
        <section class="intro"><p class="eyebrow">Thursday, 28 February</p><h1>Good morning, Alex.</h1><p class="lede">A calm view of where your money is going - and what it can do next.</p></section>
        <section class="coach-panel" aria-labelledby="coach-title"><div class="coach-copy"><span class="spark">*</span><div><p class="eyebrow">Your money, explained</p><h2 id="coach-title">Ask your coach anything.</h2></div></div><form id="ask-form" class="ask-form"><label class="sr-only" for="question">Ask a question about your money</label><input id="question" placeholder="Try &quot;What is safe for me to spend?&quot;" autocomplete="off" /><button type="submit" aria-label="Ask coach">Go</button></form><div class="prompt-row">${Object.keys(answers).map((question) => `<button class="prompt" data-question="${question}">${question}</button>`).join('')}</div><div id="answer" class="answer" hidden></div><div class="conversation" id="conversation"><div class="conversation-heading"><span>Recent questions</span><button id="clear-conversation" type="button">Clear</button></div><div class="conversation-item"><span class="conversation-dot"></span><p>What is safe for me to spend this week?</p><small>Answered just now</small></div></div></section>
        <section class="section-heading"><div><p class="eyebrow">Your month</p><h2 id="month-title">February at a glance</h2></div><div class="month-control"><button class="month-switcher" id="month-switcher" aria-expanded="false">February <span>v</span></button><div class="month-menu" id="month-menu" hidden><button data-month="February">February 2024</button><button data-month="January">January 2024</button></div></div></section>
        <section class="overview-grid"><article class="balance-card"><div class="card-top"><span>Available to spend</span><span class="help" title="Available after regular payments">?</span></div><strong id="available-value">${money(monthData.February.available)}</strong><p>after regular payments</p><div class="balance-rule"><span id="balance-width" style="width: ${monthData.February.width}%"></span></div><div class="balance-foot"><span>Safe this week</span><b id="safe-value">${money(monthData.February.safe)}</b></div></article><article class="spend-card"><div class="card-top"><span>Spent this month</span><span class="period" id="month-period">${monthData.February.label}</span></div><strong id="spent-value">${money(monthData.February.spent)}</strong><div class="bar-chart" aria-label="Spending by category">${categoryTotals.map((item) => `<span style="height:${Math.max(22, item.value / 1.15)}px" title="${item.category}: ${money(item.value)}"></span>`).join('')}</div><div class="legend">${categoryTotals.map((item) => `<span><i class="dot"></i>${item.category}</span>`).join('')}</div></article></section>
        <section class="safe-plan" id="safe-plan"><div class="section-heading"><div><p class="eyebrow">A gentle guardrail</p><h2>Make this week feel easy.</h2></div><button class="text-button" id="safe-plan-help">How is this calculated? <span>?</span></button></div><div class="safe-plan-grid"><div class="safe-plan-number"><span>Comfortable to spend</span><strong id="plan-value">118 EUR</strong><small>until next Thursday</small></div><div class="safe-plan-breakdown"><div><span>Available after bills</span><b>€187.40</b></div><div><span>Rainy-day cushion</span><b>-€50.00</b></div><div><span>Daily room</span><b id="daily-room">€16.86</b></div></div></div><input class="plan-range" id="plan-range" type="range" min="80" max="180" step="1" value="118" aria-label="Adjust comfortable weekly spending amount" /><div class="range-labels"><span>More cautious</span><span>More flexible</span></div><p class="plan-note" id="plan-note">This is a planning suggestion based on the demo profile, not a guarantee or financial advice.</p></section>
        <section class="scenario"><div><p class="eyebrow">Try a what-if</p><h2>If I cut dining out by 20%...</h2><p>Small changes become easier to see when they have a number attached.</p></div><div class="scenario-result"><strong>${money(dining * .2)}</strong><span>back in your pocket<br />each month</span></div><button class="scenario-action" id="scenario-action">Show me how <span>-></span></button></section>
        <section class="recurring-section"><div class="section-heading"><div><p class="eyebrow">Coming up</p><h2>Regular payments</h2></div><span class="recurring-total">${money(recurring.reduce((sum, item) => sum + item.amount, 0))} tracked</span></div><div class="recurring-list">${recurring.map((item) => `<div class="recurring-item"><div class="recurring-icon">↻</div><div><strong>${item.name}</strong><span>${item.detail}</span></div><b>${money(item.amount)}</b></div>`).join('')}</div></section>
        <section class="insights-section" id="insights"><div class="section-heading"><div><p class="eyebrow">A clearer picture</p><h2>Where your money lands</h2></div><button class="text-button" id="insight-help">How this works <span>?</span></button></div><p class="insights-intro">Every transaction belongs to one of three baskets. The point is not to judge it - just to make the pattern easier to see.</p><div class="basket-list">${basketData.map((basket) => `<button class="basket-item ${basket.tone}" data-basket="${basket.key}"><span class="basket-marker"></span><span class="basket-copy"><strong>${basket.label}</strong><small>${money(basket.amount)} this month</small></span><span class="basket-arrow">-></span></button>`).join('')}</div><div class="basket-detail" id="basket-detail" hidden></div></section>
        <section class="section-heading activity-heading" id="activity"><div><p class="eyebrow">The latest</p><h2>Recent activity</h2></div><div class="activity-actions"><div class="filter-wrap"><button class="filter-button" id="filter-button" aria-expanded="false">All categories <span>v</span></button><div class="filter-menu" id="filter-menu" hidden>${['All categories', 'Groceries', 'Dining out', 'Home', 'Transport', 'Income'].map((category) => `<button data-category="${category}">${category}</button>`).join('')}</div></div></div></section>
        <div class="activity-search"><span>Search</span><input id="activity-search" aria-label="Search activity" placeholder="Merchant or category" /><button id="clear-search" type="button" aria-label="Clear activity search">Clear</button></div>
        <section class="activity-list" id="activity-list">${transactions.slice(0, 5).map((tx) => transactionMarkup(tx)).join('')}</section><div class="transaction-detail" id="transaction-detail" hidden></div><button class="load-more" id="load-more">See all activity <span>-></span></button>
        <section class="monthly-story"><div><p class="eyebrow">A small monthly story</p><h2>Most of your choices were essential.</h2><p>Groceries and home costs made up 73% of tracked spending. That leaves a clear, kind place to experiment: everyday extras.</p></div><div class="story-stat"><strong>73%</strong><span>essentials</span></div></section>
        <section class="goals-section" id="goals"><div class="section-heading"><div><p class="eyebrow">Make it yours</p><h2>Small goals, visible progress</h2></div><button class="text-button" id="add-goal">+ Add a goal</button></div><div class="goal-list"><article class="goal-item"><div class="goal-icon">-></div><div class="goal-copy"><strong>Dining out, a little less</strong><span>Save 24 EUR by 31 March</span><div class="goal-track"><i style="width: 48%"></i></div></div><b>48%</b></article><article class="goal-item"><div class="goal-icon green">o</div><div class="goal-copy"><strong>Rainy day buffer</strong><span>1,200 EUR target - 720 EUR set aside</span><div class="goal-track green-track"><i style="width: 60%"></i></div></div><b>60%</b></article></div></section>
        <section class="profile-section" id="profile"><div class="section-heading"><div><p class="eyebrow">Your space</p><h2>Private by design</h2></div></div><div class="profile-row"><div class="profile-avatar">A</div><div><strong>Alex's demo profile</strong><p>Connected account - Last synced today at 09:42</p></div><button class="profile-detail" id="profile-detail">Details <span>-></span></button></div><p class="profile-trust">Your coach only uses the transactions you choose to explore. Nothing is shared, and every insight shows its source in plain language.</p><div class="profile-actions"><button class="download-data" id="download-data">Download my demo data <span>↓</span></button><button class="reset-data" id="reset-data">Reset local choices</button></div><p class="download-status" id="download-status" hidden>Your CSV is ready. Keep it wherever you keep your own records.</p><p class="reset-status" id="reset-status" hidden>Local choices cleared. Your demo transactions stay available.</p></section>
        <aside class="demo-note"><span>*</span><p>This is a private demo view using synthetic data. Your money stays yours - insights are here to help you decide, not to decide for you.</p></aside>
      </main>
      <nav class="bottom-nav" aria-label="Main navigation"><a class="active" href="#top"><span>Home</span>Overview</a><a href="#activity"><span>List</span>Activity</a><a href="#goals"><span>Goals</span>Goals</a><a href="#profile"><span>You</span>Profile</a></nav>
    </div>
  `

  const answer = document.querySelector('#answer')
  const conversation = document.querySelector('#conversation')
  let questionHistory = loadLocal('oma-raha-questions', [])
  const savedPlan = loadLocal('oma-raha-plan', 118)
  const savedGoal = loadLocal('oma-raha-goal', false)
  const reviewedMerchants = loadLocal('oma-raha-reviewed', [])
  if (questionHistory.length) conversation.innerHTML = `<div class="conversation-heading"><span>Recent questions</span><button id="clear-conversation" type="button">Clear</button></div>${questionHistory.map((question) => `<div class="conversation-item"><span class="conversation-dot"></span><p>${question}</p><small>Saved from your last visit</small></div>`).join('')}`
  const showAnswer = (question) => { answer.hidden = false; answer.innerHTML = `<strong>${question}</strong><p>${answerFor(question)}</p>`; conversation.insertAdjacentHTML('beforeend', `<div class="conversation-item fresh"><span class="conversation-dot"></span><p>${question}</p><small>Answered just now</small></div>`); questionHistory = [...questionHistory, question].slice(-5); saveLocal('oma-raha-questions', questionHistory); answer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }
  document.querySelectorAll('.prompt').forEach((button) => button.addEventListener('click', () => showAnswer(button.dataset.question)))
  document.querySelector('#ask-form').addEventListener('submit', (event) => { event.preventDefault(); const value = document.querySelector('#question').value.trim(); if (value) showAnswer(value) })
  document.querySelector('#clear-conversation').addEventListener('click', () => { questionHistory = []; saveLocal('oma-raha-questions', []); conversation.innerHTML = '<div class="conversation-heading"><span>Recent questions</span><button id="clear-conversation" type="button">Clear</button></div><p class="conversation-empty">Your next question will appear here.</p>'; document.querySelector('#clear-conversation').addEventListener('click', () => {}) })
  const basketDetail = document.querySelector('#basket-detail')
  document.querySelectorAll('.basket-item').forEach((button) => button.addEventListener('click', () => { const basket = basketData.find((item) => item.key === button.dataset.basket); basketDetail.hidden = false; basketDetail.innerHTML = `<strong>${basket.label}</strong><p>${basket.text}</p>`; document.querySelectorAll('.basket-item').forEach((item) => item.classList.toggle('selected', item === button)) }))
  document.querySelector('#insight-help').addEventListener('click', () => { basketDetail.hidden = false; basketDetail.innerHTML = '<strong>Three baskets, one useful habit.</strong><p>Regular costs are predictable. Unexpected costs need room. Everyday spending is where small experiments can help.</p>' })

  const monthMenu = document.querySelector('#month-menu')
  const monthSwitcher = document.querySelector('#month-switcher')
  monthSwitcher.addEventListener('click', () => { monthMenu.hidden = !monthMenu.hidden; monthSwitcher.setAttribute('aria-expanded', String(!monthMenu.hidden)) })
  monthMenu.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { const month = button.dataset.month; const data = monthData[month]; document.querySelector('#month-title').textContent = `${month} at a glance`; document.querySelector('#available-value').textContent = money(data.available); document.querySelector('#spent-value').textContent = money(data.spent); document.querySelector('#safe-value').textContent = money(data.safe); document.querySelector('#month-period').textContent = data.label; document.querySelector('#balance-width').style.width = `${data.width}%`; monthSwitcher.firstChild.textContent = `${month} `; monthMenu.hidden = true; monthSwitcher.setAttribute('aria-expanded', 'false') }))

  const activityList = document.querySelector('#activity-list')
  let selectedCategory = 'All categories'
  let showingAll = false
  let searchTerm = ''
  const renderTransactions = () => { const filtered = transactions.filter((tx) => (selectedCategory === 'All categories' || tx.category === selectedCategory) && `${tx.merchant} ${tx.category}`.toLowerCase().includes(searchTerm)); const visible = showingAll ? filtered : filtered.slice(0, 5); activityList.innerHTML = visible.length ? visible.map((tx) => transactionMarkup(tx)).join('') : '<p class="empty-state">No activity matched that search.</p>'; document.querySelector('#load-more').hidden = showingAll || filtered.length <= 5 || !filtered.length; bindTransactionDetails() }
  const transactionDetail = document.querySelector('#transaction-detail')
  const bindTransactionDetails = () => activityList.querySelectorAll('.transaction').forEach((button) => button.addEventListener('click', () => { transactionDetail.hidden = false; const reviewed = reviewedMerchants.includes(button.dataset.merchant); transactionDetail.innerHTML = `<div><span class="eyebrow">Transaction detail</span><h3>${button.dataset.merchant}</h3><p>${button.dataset.category} - ${button.dataset.date}</p></div><strong>${Number(button.dataset.amount) > 0 ? '+' : ''}${money(Number(button.dataset.amount))}</strong><button class="review-category ${reviewed ? 'reviewed' : ''}" type="button">${reviewed ? 'Marked for review' : 'Review category'}</button>`; transactionDetail.querySelector('.review-category').addEventListener('click', (event) => { if (!reviewedMerchants.includes(button.dataset.merchant)) reviewedMerchants.push(button.dataset.merchant); saveLocal('oma-raha-reviewed', reviewedMerchants); event.currentTarget.textContent = 'Marked for review'; event.currentTarget.classList.add('reviewed') }) }))
  bindTransactionDetails()
  const filterButton = document.querySelector('#filter-button')
  const filterMenu = document.querySelector('#filter-menu')
  filterButton.addEventListener('click', () => { filterMenu.hidden = !filterMenu.hidden; filterButton.setAttribute('aria-expanded', String(!filterMenu.hidden)) })
  filterMenu.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { selectedCategory = button.dataset.category; filterButton.firstChild.textContent = `${selectedCategory} `; filterMenu.hidden = true; filterButton.setAttribute('aria-expanded', 'false'); showingAll = false; renderTransactions() }))
  document.querySelector('#activity-search').addEventListener('input', (event) => { searchTerm = event.target.value.toLowerCase().trim(); showingAll = false; renderTransactions() })
  document.querySelector('#clear-search').addEventListener('click', () => { searchTerm = ''; document.querySelector('#activity-search').value = ''; showingAll = false; renderTransactions(); document.querySelector('#activity-search').focus() })
  document.querySelector('#load-more').addEventListener('click', () => { showingAll = true; renderTransactions() })
  document.querySelector('#scenario-action').addEventListener('click', (event) => { event.currentTarget.innerHTML = 'Saved as a small goal <span>Done</span>'; event.currentTarget.classList.add('saved') })
  const planRange = document.querySelector('#plan-range')
  const updatePlan = (value) => { planRange.value = value; document.querySelector('#plan-value').textContent = `${value} EUR`; document.querySelector('#daily-room').textContent = `${(value / 7).toFixed(2)} EUR`; document.querySelector('#plan-note').textContent = value < 105 ? 'More cautious gives you extra breathing room for the unexpected.' : value > 145 ? 'More flexible leaves less room for surprises later in the month.' : 'This middle setting balances flexibility with a little room for surprises.' }
  updatePlan(savedPlan)
  planRange.addEventListener('input', (event) => { const value = Number(event.target.value); saveLocal('oma-raha-plan', value); updatePlan(value) })
  document.querySelector('#safe-plan-help').addEventListener('click', () => { document.querySelector('#plan-note').textContent = 'We start with available money, set aside a cushion, and divide the rest across the days ahead.' })
  if (savedGoal) { document.querySelector('#add-goal').textContent = 'Goal saved'; document.querySelector('#add-goal').classList.add('added') }
  document.querySelector('#add-goal').addEventListener('click', (event) => { saveLocal('oma-raha-goal', true); event.currentTarget.textContent = 'Goal saved'; event.currentTarget.classList.add('added') })
  document.querySelector('#profile-detail').addEventListener('click', (event) => { event.currentTarget.innerHTML = 'Connected' })
  document.querySelector('#download-data').addEventListener('click', () => { const csv = ['date,merchant,category,amount_eur', ...transactions.map((tx) => `${tx.date},${tx.merchant},${tx.category},${tx.amount}`)].join('\n'); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = 'oma-raha-demo-transactions.csv'; link.click(); URL.revokeObjectURL(link.href); document.querySelector('#download-status').hidden = false })
  document.querySelector('#reset-data').addEventListener('click', (event) => { ['oma-raha-questions', 'oma-raha-plan', 'oma-raha-goal', 'oma-raha-reviewed'].forEach((key) => localStorage.removeItem(key)); event.currentTarget.textContent = 'Choices cleared'; document.querySelector('#reset-status').hidden = false })
  document.querySelector('#avatar').addEventListener('click', () => document.querySelector('#profile').scrollIntoView({ behavior: 'smooth' }))
  let installPrompt
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; document.querySelector('#install-app').hidden = false })
  document.querySelector('#install-app').addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; document.querySelector('#install-app').hidden = true })
  const connectionStatus = document.querySelector('#connection-status')
  const updateConnectionStatus = () => { connectionStatus.classList.toggle('offline', !navigator.onLine); connectionStatus.lastElementChild.textContent = navigator.onLine ? 'Ready offline' : 'Offline mode' }
  window.addEventListener('online', updateConnectionStatus)
  window.addEventListener('offline', updateConnectionStatus)
  updateConnectionStatus()
  document.querySelector('#update-notice').addEventListener('click', () => window.location.reload())
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').then((registration) => { registration.addEventListener('updatefound', () => { const worker = registration.installing; worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) document.querySelector('#update-notice').hidden = false }) }) }).catch(() => connectionStatus.classList.add('offline')))
  document.querySelectorAll('.bottom-nav a').forEach((link) => link.addEventListener('click', () => { document.querySelectorAll('.bottom-nav a').forEach((item) => item.classList.remove('active')); link.classList.add('active') }))
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { monthMenu.hidden = true; filterMenu.hidden = true; monthSwitcher.setAttribute('aria-expanded', 'false'); filterButton.setAttribute('aria-expanded', 'false') } })
}

render()

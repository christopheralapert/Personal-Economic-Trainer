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

function transactionMarkup(tx) {
  const iconClass = tx.category.toLowerCase().replaceAll(' ', '-')
  return `<div class="transaction"><div class="merchant-icon ${iconClass}">${tx.category === 'Income' ? '+' : tx.merchant.charAt(0)}</div><div class="transaction-copy"><strong>${tx.merchant}</strong><span>${tx.category} - ${tx.date}</span></div><b class="amount ${tx.amount > 0 ? 'positive' : ''}">${tx.amount > 0 ? '+' : ''}${money(tx.amount)}</b></div>`
}

function render() {
  document.querySelector('#app').innerHTML = `
    <div class="shell">
      <header class="topbar"><a class="brand" href="#top" aria-label="Oma raha home"><span class="brand-mark">o</span><span>oma raha</span></a><div class="profile"><span class="status-dot"></span><span>Demo profile</span><button class="avatar" id="avatar" aria-label="Open profile">A</button></div></header>
      <main id="top">
        <section class="intro"><p class="eyebrow">Thursday, 28 February</p><h1>Good morning, Alex.</h1><p class="lede">A calm view of where your money is going - and what it can do next.</p></section>
        <section class="coach-panel" aria-labelledby="coach-title"><div class="coach-copy"><span class="spark">*</span><div><p class="eyebrow">Your money, explained</p><h2 id="coach-title">Ask your coach anything.</h2></div></div><form id="ask-form" class="ask-form"><label class="sr-only" for="question">Ask a question about your money</label><input id="question" placeholder="Try &quot;What is safe for me to spend?&quot;" autocomplete="off" /><button type="submit" aria-label="Ask coach">Go</button></form><div class="prompt-row">${Object.keys(answers).map((question) => `<button class="prompt" data-question="${question}">${question}</button>`).join('')}</div><div id="answer" class="answer" hidden></div></section>
        <section class="section-heading"><div><p class="eyebrow">Your month</p><h2 id="month-title">February at a glance</h2></div><div class="month-control"><button class="month-switcher" id="month-switcher" aria-expanded="false">February <span>v</span></button><div class="month-menu" id="month-menu" hidden><button data-month="February">February 2024</button><button data-month="January">January 2024</button></div></div></section>
        <section class="overview-grid"><article class="balance-card"><div class="card-top"><span>Available to spend</span><span class="help" title="Available after regular payments">?</span></div><strong id="available-value">${money(monthData.February.available)}</strong><p>after regular payments</p><div class="balance-rule"><span id="balance-width" style="width: ${monthData.February.width}%"></span></div><div class="balance-foot"><span>Safe this week</span><b id="safe-value">${money(monthData.February.safe)}</b></div></article><article class="spend-card"><div class="card-top"><span>Spent this month</span><span class="period" id="month-period">${monthData.February.label}</span></div><strong id="spent-value">${money(monthData.February.spent)}</strong><div class="bar-chart" aria-label="Spending by category">${categoryTotals.map((item) => `<span style="height:${Math.max(22, item.value / 1.15)}px" title="${item.category}: ${money(item.value)}"></span>`).join('')}</div><div class="legend">${categoryTotals.map((item) => `<span><i class="dot"></i>${item.category}</span>`).join('')}</div></article></section>
        <section class="scenario"><div><p class="eyebrow">Try a what-if</p><h2>If I cut dining out by 20%...</h2><p>Small changes become easier to see when they have a number attached.</p></div><div class="scenario-result"><strong>${money(dining * .2)}</strong><span>back in your pocket<br />each month</span></div><button class="scenario-action" id="scenario-action">Show me how <span>-></span></button></section>
        <section class="section-heading activity-heading" id="activity"><div><p class="eyebrow">The latest</p><h2>Recent activity</h2></div><div class="filter-wrap"><button class="filter-button" id="filter-button" aria-expanded="false">All categories <span>v</span></button><div class="filter-menu" id="filter-menu" hidden>${['All categories', 'Groceries', 'Dining out', 'Home', 'Transport', 'Income'].map((category) => `<button data-category="${category}">${category}</button>`).join('')}</div></div></section>
        <section class="activity-list" id="activity-list">${transactions.slice(0, 5).map((tx) => transactionMarkup(tx)).join('')}</section><button class="load-more" id="load-more">See all activity <span>-></span></button>
        <section class="goals-section" id="goals"><div class="section-heading"><div><p class="eyebrow">Make it yours</p><h2>Small goals, visible progress</h2></div><button class="text-button" id="add-goal">+ Add a goal</button></div><div class="goal-list"><article class="goal-item"><div class="goal-icon">-></div><div class="goal-copy"><strong>Dining out, a little less</strong><span>Save 24 EUR by 31 March</span><div class="goal-track"><i style="width: 48%"></i></div></div><b>48%</b></article><article class="goal-item"><div class="goal-icon green">o</div><div class="goal-copy"><strong>Rainy day buffer</strong><span>1,200 EUR target - 720 EUR set aside</span><div class="goal-track green-track"><i style="width: 60%"></i></div></div><b>60%</b></article></div></section>
        <section class="profile-section" id="profile"><div class="section-heading"><div><p class="eyebrow">Your space</p><h2>Private by design</h2></div></div><div class="profile-row"><div class="profile-avatar">A</div><div><strong>Alex's demo profile</strong><p>Connected account - Last synced today at 09:42</p></div><button class="profile-detail" id="profile-detail">Details <span>-></span></button></div><p class="profile-trust">Your coach only uses the transactions you choose to explore. Nothing is shared, and every insight shows its source in plain language.</p></section>
        <aside class="demo-note"><span>*</span><p>This is a private demo view using synthetic data. Your money stays yours - insights are here to help you decide, not to decide for you.</p></aside>
      </main>
      <nav class="bottom-nav" aria-label="Main navigation"><a class="active" href="#top"><span>Home</span>Overview</a><a href="#activity"><span>List</span>Activity</a><a href="#goals"><span>Goals</span>Goals</a><a href="#profile"><span>You</span>Profile</a></nav>
    </div>
  `

  const answer = document.querySelector('#answer')
  const showAnswer = (question) => { answer.hidden = false; answer.innerHTML = `<strong>${question}</strong><p>${answers[question] ?? 'I can help with spending, categories, recurring costs, and simple what-if scenarios. Try one of the prompts below.'}</p>`; answer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }
  document.querySelectorAll('.prompt').forEach((button) => button.addEventListener('click', () => showAnswer(button.dataset.question)))
  document.querySelector('#ask-form').addEventListener('submit', (event) => { event.preventDefault(); const value = document.querySelector('#question').value.trim(); if (value) showAnswer(value) })

  const monthMenu = document.querySelector('#month-menu')
  const monthSwitcher = document.querySelector('#month-switcher')
  monthSwitcher.addEventListener('click', () => { monthMenu.hidden = !monthMenu.hidden; monthSwitcher.setAttribute('aria-expanded', String(!monthMenu.hidden)) })
  monthMenu.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { const month = button.dataset.month; const data = monthData[month]; document.querySelector('#month-title').textContent = `${month} at a glance`; document.querySelector('#available-value').textContent = money(data.available); document.querySelector('#spent-value').textContent = money(data.spent); document.querySelector('#safe-value').textContent = money(data.safe); document.querySelector('#month-period').textContent = data.label; document.querySelector('#balance-width').style.width = `${data.width}%`; monthSwitcher.firstChild.textContent = `${month} `; monthMenu.hidden = true; monthSwitcher.setAttribute('aria-expanded', 'false') }))

  const activityList = document.querySelector('#activity-list')
  let selectedCategory = 'All categories'
  let showingAll = false
  const renderTransactions = () => { const filtered = selectedCategory === 'All categories' ? transactions : transactions.filter((tx) => tx.category === selectedCategory); const visible = showingAll ? filtered : filtered.slice(0, 5); activityList.innerHTML = visible.length ? visible.map((tx) => transactionMarkup(tx)).join('') : '<p class="empty-state">No activity in this category yet.</p>'; document.querySelector('#load-more').hidden = showingAll || filtered.length <= 5 || !filtered.length }
  const filterButton = document.querySelector('#filter-button')
  const filterMenu = document.querySelector('#filter-menu')
  filterButton.addEventListener('click', () => { filterMenu.hidden = !filterMenu.hidden; filterButton.setAttribute('aria-expanded', String(!filterMenu.hidden)) })
  filterMenu.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { selectedCategory = button.dataset.category; filterButton.firstChild.textContent = `${selectedCategory} `; filterMenu.hidden = true; filterButton.setAttribute('aria-expanded', 'false'); showingAll = false; renderTransactions() }))
  document.querySelector('#load-more').addEventListener('click', () => { showingAll = true; renderTransactions() })
  document.querySelector('#scenario-action').addEventListener('click', (event) => { event.currentTarget.innerHTML = 'Saved as a small goal <span>Done</span>'; event.currentTarget.classList.add('saved') })
  document.querySelector('#add-goal').addEventListener('click', (event) => { event.currentTarget.textContent = 'Goal added'; event.currentTarget.classList.add('added') })
  document.querySelector('#profile-detail').addEventListener('click', (event) => { event.currentTarget.innerHTML = 'Connected' })
  document.querySelector('#avatar').addEventListener('click', () => document.querySelector('#profile').scrollIntoView({ behavior: 'smooth' }))
  document.querySelectorAll('.bottom-nav a').forEach((link) => link.addEventListener('click', () => { document.querySelectorAll('.bottom-nav a').forEach((item) => item.classList.remove('active')); link.classList.add('active') }))
}

render()

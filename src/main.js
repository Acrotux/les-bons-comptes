import './style.css';
import { supabase } from './supabase.js';
import * as api from './api.js';
import { computeBalances, computeTransactions, formatCents } from './balances.js';

const app = document.getElementById('app');

const CATEGORIES = ['Anniversaire', 'Famille', 'Professionnel', 'Voyage', 'Autre'];

const S = {
  session: null,
  profile: null,
  view: 'loading', // loading | auth | confirm-email | reset-sent | onboarding-name | home | list | profile | friends
  authMode: 'login', // login | signup | forgot
  pendingEmail: '',
  error: '',
  profileNotice: '',
  lists: [],
  homeTab: 'toutes',
  list: null,
  listTab: 'apercu',
  members: [],
  memberProfiles: {}, // profile_id -> { display_name, avatar_url }
  memberSearchResults: [],
  expenses: [],
  settlements: [],
  friends: [],
  pendingInvites: [],
  friendSearchResults: [],
  friendSearchQuery: '',
  friendSearchNoMatch: false,
  unsubscribe: null,
  inlineEdit: null, // { type: 'member', id } | { type: 'confirm-remove-member', id }
};

function setState(patch) {
  Object.assign(S, patch);
  render();
}

function nameOf(id) {
  const m = S.members.find((x) => x.id === id);
  return m ? m.display_name : '?';
}

// ---------------- Boot ----------------

async function boot() {
  const session = await api.getSession();
  api.onAuthStateChange((session) => {
    S.session = session;
    if (session) afterLogin();
    else if (S.view !== 'reset-sent') setState({ view: 'auth', authMode: 'login', profile: null });
  });
  if (session) {
    S.session = session;
    await afterLogin();
  } else {
    const authMode = location.hash === '#inscription' ? 'signup' : 'login';
    setState({ view: 'auth', authMode });
  }
  window.addEventListener('hashchange', routeFromHash);
}

async function afterLogin() {
  const { data: existing } = await supabase.from('profiles').select('*').eq('id', S.session.user.id).maybeSingle();
  if (!existing) {
    setState({ view: 'onboarding-name' });
    return;
  }
  S.profile = existing;
  await api.claimInvites(S.session.user.email);
  routeFromHash();
}

async function routeFromHash() {
  const m = location.hash.match(/^#\/list\/([a-f0-9-]+)/i);
  if (location.hash === '#/profil') {
    if (S.unsubscribe) { S.unsubscribe(); S.unsubscribe = null; }
    setState({ view: 'profile', error: '', profileNotice: '' });
  } else if (location.hash === '#/amis') {
    await loadFriends();
  } else if (m) {
    await openList(m[1]);
  } else {
    await loadHome();
  }
}

async function loadFriends() {
  if (S.unsubscribe) { S.unsubscribe(); S.unsubscribe = null; }
  const [friends, pendingInvites] = await Promise.all([api.listFriends(), api.listPendingFriendInvites()]);
  setState({
    view: 'friends',
    friends,
    pendingInvites,
    friendSearchResults: [],
    friendSearchQuery: '',
    friendSearchNoMatch: false,
    error: '',
  });
}

async function loadHome() {
  if (S.unsubscribe) { S.unsubscribe(); S.unsubscribe = null; }
  const lists = await api.fetchMyLists();
  setState({ view: 'home', lists, list: null });
}

async function openList(listId) {
  if (S.unsubscribe) { S.unsubscribe(); S.unsubscribe = null; }
  try {
    const list = await api.getList(listId);
    const [members, expenses, settlements, memberProfilesArr] = await Promise.all([
      api.getMembers(listId),
      api.getExpenses(listId),
      api.getSettlements(listId),
      api.getMemberProfiles(listId),
    ]);
    const memberProfiles = Object.fromEntries(memberProfilesArr.map((p) => [p.profile_id, p]));
    S.unsubscribe = api.subscribeToList(listId, () => refreshList(listId));
    setState({ view: 'list', list, members, expenses, settlements, memberProfiles, memberSearchResults: [], listTab: 'apercu' });
    location.hash = `#/list/${listId}`;
  } catch (e) {
    setState({ view: 'home', error: "Liste introuvable ou accès non autorisé." });
  }
}

async function refreshList(listId) {
  const [list, members, expenses, settlements, memberProfilesArr] = await Promise.all([
    api.getList(listId),
    api.getMembers(listId),
    api.getExpenses(listId),
    api.getSettlements(listId),
    api.getMemberProfiles(listId),
  ]);
  const memberProfiles = Object.fromEntries(memberProfilesArr.map((p) => [p.profile_id, p]));
  setState({ list, members, expenses, settlements, memberProfiles });
}

// ---------------- Render ----------------

function render() {
  if (S.view === 'loading') app.innerHTML = `<div class="center-screen">Chargement…</div>`;
  else if (S.view === 'auth') app.innerHTML = renderAuth();
  else if (S.view === 'confirm-email') app.innerHTML = renderConfirmEmail();
  else if (S.view === 'reset-sent') app.innerHTML = renderResetSent();
  else if (S.view === 'onboarding-name') app.innerHTML = renderOnboarding();
  else if (S.view === 'profile') app.innerHTML = renderTopbar() + renderProfilePage();
  else if (S.view === 'friends') app.innerHTML = renderTopbar() + renderFriendsPage();
  else if (S.view === 'home') app.innerHTML = renderTopbar() + renderHome();
  else if (S.view === 'list') app.innerHTML = renderTopbar() + renderList();
}

function renderTopbar() {
  const avatar = S.profile?.avatar_url
    ? `<img class="avatar-mini" src="${escapeHtml(S.profile.avatar_url)}" alt="" />`
    : `<span class="avatar-mini avatar-placeholder">${escapeHtml((S.profile?.display_name || '?')[0].toUpperCase())}</span>`;
  return `
    <div class="topbar">
      <a href="#/" class="brand">🧾 Les Bons Comptes</a>
      <div class="profile-chip">
        <a class="nav-link" href="#/amis">👥 Amis</a>
        <a class="profile-link" href="#/profil">${avatar}<span>${escapeHtml(S.profile?.display_name || '')}</span></a>
        <button data-action="logout">Se déconnecter</button>
      </div>
    </div>
    ${S.error ? `<div class="banner error">${escapeHtml(S.error)}</div>` : ''}
  `;
}

function renderAuth() {
  if (S.authMode === 'signup') return renderSignup();
  if (S.authMode === 'forgot') return renderForgot();
  return renderLogin();
}

function renderLogin() {
  return `
    <div class="center-screen">
      <div class="card auth-card">
        <h1>🧾 Les Bons Comptes</h1>
        <p class="muted">Connecte-toi pour retrouver tes listes.</p>
        ${S.error ? `<div class="banner error">${escapeHtml(S.error)}</div>` : ''}
        <form data-action="login">
          <label>Adresse email</label>
          <input type="email" name="email" required placeholder="toi@exemple.com" />
          <label>Mot de passe</label>
          <input type="password" name="password" required />
          <button type="submit">Se connecter</button>
        </form>
        <button class="link-btn" data-action="show-signup">Créer un compte</button>
        <button class="link-btn" data-action="show-forgot">Mot de passe oublié ?</button>
      </div>
    </div>
  `;
}

function renderSignup() {
  return `
    <div class="center-screen">
      <div class="card auth-card">
        <h1>Créer un compte</h1>
        ${S.error ? `<div class="banner error">${escapeHtml(S.error)}</div>` : ''}
        <form data-action="signup">
          <label>Pseudo</label>
          <input type="text" name="name" required placeholder="Ex : Marie" />
          <label>Adresse email</label>
          <input type="email" name="email" required placeholder="toi@exemple.com" />
          <label>Mot de passe</label>
          <input type="password" name="password" required minlength="6" placeholder="6 caractères minimum" />
          <button type="submit">Créer mon compte</button>
        </form>
        <button class="link-btn" data-action="show-login">J'ai déjà un compte</button>
      </div>
    </div>
  `;
}

function renderForgot() {
  return `
    <div class="center-screen">
      <div class="card auth-card">
        <h1>Mot de passe oublié</h1>
        <p class="muted">Un lien de réinitialisation te sera envoyé par email.</p>
        ${S.error ? `<div class="banner error">${escapeHtml(S.error)}</div>` : ''}
        <form data-action="forgot-password">
          <label>Adresse email</label>
          <input type="email" name="email" required placeholder="toi@exemple.com" />
          <button type="submit">Envoyer le lien</button>
        </form>
        <button class="link-btn" data-action="show-login">Retour à la connexion</button>
      </div>
    </div>
  `;
}

function renderConfirmEmail() {
  return `
    <div class="center-screen">
      <div class="card auth-card">
        <h1>Vérifie ta boîte mail</h1>
        <p class="muted">Un email de confirmation a été envoyé à <strong>${escapeHtml(S.pendingEmail)}</strong>. Clique sur le lien qu'il contient, puis reviens te connecter avec ton mot de passe.</p>
        <button class="link-btn" data-action="show-login">Retour à la connexion</button>
      </div>
    </div>
  `;
}

function renderResetSent() {
  return `
    <div class="center-screen">
      <div class="card auth-card">
        <h1>Email envoyé</h1>
        <p class="muted">Vérifie ta boîte mail et suis le lien pour choisir un nouveau mot de passe.</p>
        <button class="link-btn" data-action="show-login">Retour à la connexion</button>
      </div>
    </div>
  `;
}

function renderOnboarding() {
  return `
    <div class="center-screen">
      <div class="card auth-card">
        <h1>Bienvenue 👋</h1>
        <p class="muted">Comment veux-tu que les autres te voient ?</p>
        <form data-action="set-profile-name">
          <label>Ton nom ou pseudo</label>
          <input type="text" name="name" required placeholder="Ex : Marie" />
          <button type="submit">Continuer</button>
        </form>
      </div>
    </div>
  `;
}

function renderProfilePage() {
  const p = S.profile;
  const avatar = p?.avatar_url
    ? `<img class="avatar-large" src="${escapeHtml(p.avatar_url)}" alt="" />`
    : `<span class="avatar-large avatar-placeholder">${escapeHtml((p?.display_name || '?')[0].toUpperCase())}</span>`;
  return `
    <div class="page">
      <h1>Mon profil</h1>
      ${S.profileNotice ? `<div class="banner notice">${escapeHtml(S.profileNotice)}</div>` : ''}

      <div class="card">
        <h2>Photo de profil</h2>
        <div class="avatar-row">
          ${avatar}
          <form data-action="upload-avatar" class="avatar-form">
            <input type="file" name="avatar" accept="image/*" required />
            <button type="submit">Changer la photo</button>
          </form>
        </div>
      </div>

      <div class="card">
        <h2>Pseudo</h2>
        <form data-action="update-profile-name">
          <input type="text" name="name" value="${escapeHtml(p?.display_name || '')}" required />
          <button type="submit">Enregistrer</button>
        </form>
      </div>

      <div class="card">
        <h2>Adresse email</h2>
        <p class="muted">Actuelle : ${escapeHtml(S.session.user.email)}</p>
        <form data-action="update-email">
          <input type="email" name="email" required placeholder="nouvelle-adresse@exemple.com" />
          <button type="submit">Changer l'email</button>
        </form>
      </div>

      <div class="card">
        <h2>Mot de passe</h2>
        <form data-action="update-password">
          <input type="password" name="password" required minlength="6" placeholder="Nouveau mot de passe (6 caractères min.)" />
          <button type="submit">Changer le mot de passe</button>
        </form>
      </div>

      <a class="link-btn" href="#/">&larr; Retour</a>
    </div>
  `;
}

function renderFriendsPage() {
  const grouped = {};
  for (const f of S.friends) {
    (grouped[f.category] ||= []).push(f);
  }
  const categories = Object.keys(grouped).sort();
  const ownCategories = [...new Set(S.friends.map((f) => f.category))].sort();

  return `
    <div class="page">
      <h1>Mes amis</h1>

      <datalist id="friend-category-options">
        ${ownCategories.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('')}
      </datalist>

      <div class="card">
        <h2>Ajouter un ami</h2>
        <input type="text" data-action="friend-search-input" placeholder="Rechercher un pseudo ou un email…" />
        <label class="muted">Catégorie pour ce nouvel ami (optionnel, tu peux créer la tienne)</label>
        <input type="text" id="new-friend-category" list="friend-category-options" placeholder="Ex : Famille, Collègues, Rugby…" />
        ${S.friendSearchResults.length ? `
          <ul class="search-results">
            ${S.friendSearchResults.map((p) => `
              <li>
                ${p.avatar_url ? `<img class="avatar-mini" src="${escapeHtml(p.avatar_url)}" alt="" />` : `<span class="avatar-mini avatar-placeholder">${escapeHtml(p.display_name[0].toUpperCase())}</span>`}
                <span>${escapeHtml(p.display_name)}</span>
                <button data-action="add-friend" data-id="${p.id}">Ajouter</button>
              </li>
            `).join('')}
          </ul>
        ` : ''}
        ${S.friendSearchNoMatch ? `
          <p class="muted">Personne n'a de compte avec cet email pour l'instant. En l'invitant, ton client mail s'ouvrira avec un message prêt à envoyer.</p>
          <button data-action="invite-friend-by-email" data-email="${escapeHtml(S.friendSearchQuery)}">Inviter ${escapeHtml(S.friendSearchQuery)} par email</button>
        ` : ''}
      </div>

      ${S.pendingInvites.length ? `
        <h2>Invitations en attente</h2>
        <ul class="member-list">
          ${S.pendingInvites.map((inv) => `
            <li>
              <span>${escapeHtml(inv.email)}</span>
              <span class="badge muted">en attente</span>
              <button class="icon-btn" data-action="cancel-friend-invite" data-id="${inv.id}">🗑</button>
            </li>
          `).join('')}
        </ul>
      ` : ''}

      ${categories.length ? categories.map((cat) => `
        <h2>${escapeHtml(cat)}</h2>
        <ul class="member-list">
          ${grouped[cat].map((f) => `
            <li>
              ${f.avatar_url ? `<img class="avatar-mini" src="${escapeHtml(f.avatar_url)}" alt="" />` : `<span class="avatar-mini avatar-placeholder">${escapeHtml(f.display_name[0].toUpperCase())}</span>`}
              <span>${escapeHtml(f.display_name)}</span>
              <input type="text" list="friend-category-options" data-action="update-friend-category" data-id="${f.id}" value="${escapeHtml(f.category)}" />
              <button class="icon-btn" data-action="remove-friend" data-id="${f.id}">🗑</button>
            </li>
          `).join('')}
        </ul>
      `).join('') : '<p class="muted">Aucun ami ajouté pour l\'instant.</p>'}
    </div>
  `;
}

function renderHome() {
  const usedCategories = [...new Set(S.lists.map((l) => l.category).filter(Boolean))].sort();
  const hasUncategorized = S.lists.some((l) => !l.category);
  const tabs = [
    { key: 'toutes', label: 'Toutes' },
    ...usedCategories.map((c) => ({ key: c, label: c })),
    ...(hasUncategorized ? [{ key: '__none__', label: 'Sans catégorie' }] : []),
  ];
  const activeTab = tabs.some((t) => t.key === S.homeTab) ? S.homeTab : 'toutes';

  const listCard = (l) => `
    <a class="card list-card" href="#/list/${l.id}">
      <div class="list-card-title">${escapeHtml(l.name)}</div>
      <div class="list-card-meta">
        <span class="badge ${l.status}">${l.status === 'open' ? 'ouverte' : 'clôturée'}</span>
        <span class="badge muted">${l.is_private ? 'privée' : 'publique'}</span>
        ${l.category ? `<span class="badge muted">${escapeHtml(l.category)}</span>` : ''}
      </div>
    </a>
  `;

  const filtered = activeTab === 'toutes'
    ? S.lists
    : activeTab === '__none__'
      ? S.lists.filter((l) => !l.category)
      : S.lists.filter((l) => l.category === activeTab);
  const open = filtered.filter((l) => l.status === 'open');
  const closed = filtered.filter((l) => l.status === 'closed');
  const tabContent = `
    <h2>Listes en cours</h2>
    <div class="list-grid">${open.length ? open.map(listCard).join('') : '<p class="muted">Aucune liste en cours.</p>'}</div>
    ${closed.length ? `<h2>Historique</h2><div class="list-grid">${closed.map(listCard).join('')}</div>` : ''}
  `;

  return `
    <div class="page">
      <div class="card">
        <h2>Nouvelle liste</h2>
        <form data-action="create-list" class="create-list-form">
          <input type="text" name="name" required placeholder="Ex : Week-end à Lyon" />
          <select name="category">
            <option value="">Sans catégorie</option>
            ${CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
          </select>
          <label class="checkbox"><input type="checkbox" name="isPrivate" /> Privée (accessible seulement par lien/invitation)</label>
          <button type="submit">Créer</button>
        </form>
      </div>

      <div class="tabs">
        ${tabs.map((t) => `<button class="tab ${t.key === activeTab ? 'active' : ''}" data-action="switch-home-tab" data-tab="${t.key}">${escapeHtml(t.label)}</button>`).join('')}
      </div>

      ${tabContent}
    </div>
  `;
}

function renderList() {
  const list = S.list;
  const uid = S.session.user.id;
  const isCreator = list.created_by === uid;
  const myMember = S.members.find((m) => m.profile_id === uid);
  const isMember = !!myMember;

  const { total, balances, memberIds } = computeBalances(S.members, S.expenses, S.settlements);
  const { balances: grossBalances } = computeBalances(S.members, S.expenses, []);
  const transactions = computeTransactions(balances, memberIds);

  const listTabs = [
    { key: 'apercu', label: '📊 Aperçu' },
    { key: 'participants', label: 'Participants' },
    { key: 'depenses', label: 'Dépenses' },
    { key: 'soldes', label: 'Soldes' },
    { key: 'remboursements', label: 'Remboursements suggérés' },
  ];
  const activeTab = listTabs.some((t) => t.key === S.listTab) ? S.listTab : 'apercu';

  let tabContent;
  if (activeTab === 'apercu') {
    tabContent = renderListOverview(memberIds, balances, grossBalances);
  } else if (activeTab === 'participants') {
    tabContent = `
      <div class="card">
        <h2>Participants</h2>
        <ul class="member-list">
          ${S.members.map((m) => renderMember(m, isCreator)).join('')}
        </ul>
        <form data-action="add-member" class="add-member-form">
          <input type="text" name="name" required placeholder="Nom ou pseudo du participant" data-action="member-search-input" />
          <input type="email" name="email" placeholder="Email (optionnel)" />
          <button type="submit">Ajouter comme nouveau</button>
        </form>
        ${S.memberSearchResults.length ? `
          <p class="muted">Ce pseudo existe déjà — ajoute directement cette personne :</p>
          <ul class="search-results">
            ${S.memberSearchResults.map((p) => `
              <li>
                ${p.avatar_url ? `<img class="avatar-mini" src="${escapeHtml(p.avatar_url)}" alt="" />` : `<span class="avatar-mini avatar-placeholder">${escapeHtml(p.display_name[0].toUpperCase())}</span>`}
                <span>${escapeHtml(p.display_name)}</span>
                <button data-action="add-member-from-search" data-id="${p.id}" data-name="${escapeHtml(p.display_name)}">Ajouter</button>
              </li>
            `).join('')}
          </ul>
        ` : ''}
      </div>
    `;
  } else if (activeTab === 'depenses') {
    tabContent = `
      <div class="card">
        <h2>Dépenses <span class="muted">(total ${formatCents(total)})</span></h2>
        <ul class="expense-list">
          ${S.expenses.map((e) => renderExpense(e, uid, isCreator)).join('') || '<p class="muted">Aucune dépense pour l\'instant.</p>'}
        </ul>
        ${isMember ? `
          <form data-action="add-expense" class="expense-form">
            <select name="memberId" class="payer-select">
              ${S.members.map((m) => `<option value="${m.id}">${escapeHtml(m.display_name)}</option>`).join('')}
            </select>
            <input type="text" name="label" required placeholder="Libellé (ex : Courses)" />
            <input type="number" name="amount" required min="0.01" step="0.01" placeholder="Montant €" />
            <button type="submit">Ajouter</button>
          </form>
        ` : ''}
      </div>
    `;
  } else if (activeTab === 'soldes') {
    tabContent = `
      <div class="card">
        <h2>Soldes</h2>
        <ul class="balance-list">
          ${memberIds.map((id) => renderBalance(id, balances[id])).join('')}
        </ul>
      </div>
    `;
  } else {
    tabContent = `
      <div class="card">
        <h2>Remboursements suggérés</h2>
        ${transactions.length ? `<ul class="tx-list">${transactions.map((t) => renderTransaction(t, myMember)).join('')}</ul>` : '<p class="muted">Tout le monde est à jour 🎉</p>'}
        ${renderPendingSettlements(myMember)}
        ${isMember ? `
          <h3>Déclarer un remboursement (montant libre, aussi partiel)</h3>
          <form data-action="declare-custom-settlement" class="custom-settlement-form">
            <select name="toMemberId">
              ${S.members.filter((m) => m.id !== myMember.id).map((m) => `<option value="${m.id}">${escapeHtml(m.display_name)}</option>`).join('')}
            </select>
            <input type="number" name="amount" required min="0.01" step="0.01" placeholder="Montant €" />
            <button type="submit">J'ai remboursé</button>
          </form>
        ` : ''}
      </div>
    `;
  }

  return `
    <div class="page">
      <div class="list-header">
        <h1>${escapeHtml(list.name)}</h1>
        <div class="list-header-actions">
          <span class="badge ${list.status}">${list.status === 'open' ? 'ouverte' : 'clôturée'}</span>
          <span class="badge muted">${list.is_private ? 'privée' : 'publique'}</span>
          ${isCreator ? `
            <select data-action="update-list-category">
              <option value="">Sans catégorie</option>
              ${CATEGORIES.map((c) => `<option value="${c}" ${c === list.category ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          ` : list.category ? `<span class="badge muted">${escapeHtml(list.category)}</span>` : ''}
          <button data-action="copy-link">Copier le lien</button>
          ${isCreator ? `<button data-action="toggle-privacy" data-private="${list.is_private}">${list.is_private ? 'Rendre publique' : 'Rendre privée'}</button>` : ''}
          ${isCreator ? `<button data-action="toggle-status" data-status="${list.status}">${list.status === 'open' ? 'Clôturer' : 'Rouvrir'}</button>` : ''}
        </div>
      </div>

      ${list.status === 'closed' ? renderSummaryMailto(list, memberIds, balances) : ''}

      ${!isMember && !list.is_private ? `
        <div class="card">
          <p>Tu n'es pas encore participant de cette liste.</p>
          <button data-action="join-list">Rejoindre la liste</button>
        </div>
      ` : ''}

      <div class="tabs">
        ${listTabs.map((t) => `<button class="tab ${t.key === activeTab ? 'active' : ''}" data-action="switch-list-tab" data-tab="${t.key}">${escapeHtml(t.label)}</button>`).join('')}
      </div>

      ${tabContent}
    </div>
  `;
}

function renderListOverview(memberIds, balances, grossBalances) {
  let totalToReimburse = 0;
  let alreadyReimbursed = 0;
  let debtorsCount = 0;
  let settledDebtorsCount = 0;

  for (const id of memberIds) {
    if (grossBalances[id] > 0) totalToReimburse += grossBalances[id];
    if (balances[id] < 0) debtorsCount += 1;
    if (grossBalances[id] < 0 && balances[id] >= 0) settledDebtorsCount += 1;
  }
  for (const s of S.settlements) {
    if (s.confirmed_at) alreadyReimbursed += s.amount_cents;
  }
  const remaining = Math.max(0, totalToReimburse - alreadyReimbursed);

  const tile = (value, label) => `<div class="card stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;

  return `
    <div class="stat-grid">
      ${tile(formatCents(totalToReimburse), 'Montant total à rembourser')}
      ${tile(formatCents(remaining), 'Montant restant à rembourser')}
      ${tile(formatCents(alreadyReimbursed), 'Montant déjà remboursé')}
      ${tile(memberIds.length, 'Participants dans la liste')}
      ${tile(debtorsCount, "N'ont pas encore remboursé leurs dettes")}
      ${tile(settledDebtorsCount, 'Ont remboursé leurs dettes')}
    </div>
  `;
}

function renderSummaryMailto(list, memberIds, balances) {
  const emails = S.members.map((m) => m.email).filter(Boolean);
  if (!emails.length) return '';
  const lines = memberIds.map((id) => {
    const c = balances[id] || 0;
    const label = c > 0 ? `doit recevoir ${formatCents(c)}` : c < 0 ? `doit ${formatCents(-c)}` : 'à jour';
    return `${nameOf(id)} : ${label}`;
  });
  const subject = encodeURIComponent(`Récapitulatif — ${list.name}`);
  const body = encodeURIComponent(`Voici le récapitulatif final de la liste "${list.name}" :\n\n${lines.join('\n')}`);
  const bcc = encodeURIComponent(emails.join(','));
  return `
    <div class="card">
      <p>Liste clôturée — tu peux envoyer un récapitulatif par email à tous les participants.</p>
      <a href="mailto:?bcc=${bcc}&subject=${subject}&body=${body}">📧 Envoyer le récapitulatif</a>
    </div>
  `;
}

function renderMemberAvatar(m) {
  const profile = m.profile_id ? S.memberProfiles[m.profile_id] : null;
  const isCreator = m.profile_id && m.profile_id === S.list?.created_by;
  const img = profile?.avatar_url
    ? `<img class="avatar-mini" src="${escapeHtml(profile.avatar_url)}" alt="" />`
    : `<span class="avatar-mini avatar-placeholder">${escapeHtml(m.display_name[0].toUpperCase())}</span>`;
  return `<span class="avatar-wrap">${img}${isCreator ? '<span class="crown" title="Créateur de la liste">👑</span>' : ''}</span>`;
}

function renderMember(m, isCreator) {
  if (S.inlineEdit && S.inlineEdit.type === 'member' && S.inlineEdit.id === m.id) {
    return `
      <li>
        <form data-action="edit-member-inline" data-id="${m.id}" class="inline-edit-form">
          <input type="text" name="name" value="${escapeHtml(m.display_name)}" required class="inline-edit-input" />
          <input type="email" name="email" value="${escapeHtml(m.email || '')}" placeholder="Email" class="inline-edit-input" />
          <button type="submit">OK</button>
          <button type="button" data-action="cancel-inline">Annuler</button>
        </form>
      </li>
    `;
  }
  if (S.inlineEdit && S.inlineEdit.type === 'confirm-remove-member' && S.inlineEdit.id === m.id) {
    return `
      <li>
        <span>Supprimer ${escapeHtml(m.display_name)} ?</span>
        <button data-action="confirm-remove-member" data-id="${m.id}">Confirmer</button>
        <button data-action="cancel-inline">Annuler</button>
      </li>
    `;
  }
  return `
    <li>
      ${renderMemberAvatar(m)}
      <span>${escapeHtml(m.display_name)}</span>
      ${!m.profile_id ? '<span class="badge muted">en attente</span>' : ''}
      ${m.email ? `<a class="mail-link" href="mailto:${escapeHtml(m.email)}">✉</a>` : '<span class="badge muted">pas d\'e-mail</span>'}
      ${isCreator ? `<button class="icon-btn" data-action="edit-member" data-id="${m.id}">✎</button>` : ''}
      ${isCreator ? `<button class="icon-btn" data-action="remove-member" data-id="${m.id}">🗑</button>` : ''}
    </li>
  `;
}

function renderExpense(e, uid, isCreator) {
  const canDelete = e.added_by === uid || isCreator;
  return `
    <li class="expense-item">
      <span class="expense-label">${escapeHtml(e.label)}</span>
      <span class="expense-amount">${formatCents(e.amount_cents)}</span>
      <span class="expense-payer">payé par
        ${isCreator ? `
          <select data-action="reassign-expense" data-id="${e.id}" class="reassign-select">
            ${S.members.map((m) => `<option value="${m.id}" ${m.id === e.member_id ? 'selected' : ''}>${escapeHtml(m.display_name)}</option>`).join('')}
          </select>
        ` : `<strong>${escapeHtml(nameOf(e.member_id))}</strong>`}
      </span>
      ${canDelete ? `<button class="icon-btn" data-action="remove-expense" data-id="${e.id}">🗑</button>` : ''}
    </li>
  `;
}

function renderBalance(id, cents) {
  const cls = cents > 0 ? 'credit' : cents < 0 ? 'debt' : 'even';
  const label = cents > 0 ? `doit recevoir ${formatCents(cents)}` : cents < 0 ? `doit ${formatCents(-cents)}` : 'à jour';
  return `<li class="balance-item"><span>${escapeHtml(nameOf(id))}</span><span class="pill ${cls}">${label}</span></li>`;
}

function renderTransaction(t, myMember) {
  const canDeclare = myMember && myMember.id === t.from;
  return `
    <li class="tx-item">
      <span>${escapeHtml(nameOf(t.from))} → ${escapeHtml(nameOf(t.to))} : <strong>${formatCents(t.amount)}</strong></span>
      ${canDeclare ? `<button data-action="declare-settlement" data-from="${t.from}" data-to="${t.to}" data-amount="${t.amount}">J'ai remboursé</button>` : ''}
    </li>
  `;
}

function renderPendingSettlements(myMember) {
  const pending = S.settlements.filter((s) => !s.confirmed_at);
  if (!pending.length) return '';
  return `
    <h3>En attente de confirmation</h3>
    <ul class="tx-list">
      ${pending.map((s) => {
        const canConfirm = myMember && myMember.id === s.to_member_id;
        return `
          <li class="tx-item settlement">
            <span>${escapeHtml(nameOf(s.from_member_id))} → ${escapeHtml(nameOf(s.to_member_id))} : <strong>${formatCents(s.amount_cents)}</strong> (déclaré, non confirmé)</span>
            ${canConfirm ? `<button data-action="confirm-settlement" data-id="${s.id}">Confirmer réception</button>` : ''}
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- Events ----------------

app.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-action]');
  if (!form) return;
  e.preventDefault();
  const action = form.dataset.action;
  const data = Object.fromEntries(new FormData(form).entries());

  try {
    if (action === 'login') {
      await api.signInWithPassword(data.email, data.password);
      // onAuthStateChange déclenchera afterLogin()
    } else if (action === 'signup') {
      const { session } = await api.signUp(data.email, data.password);
      if (session) {
        S.session = session;
        const profile = await api.ensureProfile(session.user, data.name);
        S.profile = profile;
        await api.claimInvites(session.user.email);
        routeFromHash();
      } else {
        setState({ view: 'confirm-email', pendingEmail: data.email, error: '' });
      }
    } else if (action === 'forgot-password') {
      await api.resetPassword(data.email);
      setState({ view: 'reset-sent', error: '' });
    } else if (action === 'set-profile-name') {
      const profile = await api.ensureProfile(S.session.user, data.name);
      S.profile = profile;
      await api.claimInvites(S.session.user.email);
      routeFromHash();
    } else if (action === 'create-list') {
      const list = await api.createList(data.name, !!data.isPrivate, data.category, S.profile.display_name);
      await openList(list.id);
    } else if (action === 'add-member') {
      await api.addMember(S.list.id, data.name, data.email);
      form.reset();
    } else if (action === 'add-expense') {
      const cents = Math.round(parseFloat(data.amount) * 100);
      await api.addExpense(S.list.id, data.memberId, data.label, cents);
      form.reset();
    } else if (action === 'edit-member-inline') {
      const id = form.dataset.id;
      await api.updateMember(id, data.name, data.email);
      setState({ inlineEdit: null });
    } else if (action === 'update-profile-name') {
      await api.updateProfileName(S.session.user.id, data.name);
      S.profile = { ...S.profile, display_name: data.name };
      setState({ profileNotice: 'Pseudo mis à jour.' });
    } else if (action === 'upload-avatar') {
      const file = form.avatar.files[0];
      const avatarUrl = await api.uploadAvatar(S.session.user.id, file);
      S.profile = { ...S.profile, avatar_url: avatarUrl };
      form.reset();
      setState({ profileNotice: 'Photo de profil mise à jour.' });
    } else if (action === 'update-email') {
      await api.updateEmail(data.email);
      form.reset();
      setState({ profileNotice: `Un email de confirmation a été envoyé à ${data.email} et à ton adresse actuelle. Le changement prendra effet une fois confirmé.` });
    } else if (action === 'update-password') {
      await api.updatePassword(data.password);
      form.reset();
      setState({ profileNotice: 'Mot de passe mis à jour.' });
    } else if (action === 'declare-custom-settlement') {
      const myMember = S.members.find((m) => m.profile_id === S.session.user.id);
      const cents = Math.round(parseFloat(data.amount) * 100);
      await api.declareSettlement(S.list.id, myMember.id, data.toMemberId, cents);
      form.reset();
    }
  } catch (err) {
    setState({ error: friendlyError(err) });
  }
});

app.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.closest('form')) return;
  const action = btn.dataset.action;

  try {
    if (action === 'logout') {
      await api.signOut();
      setState({ view: 'auth', authMode: 'login', session: null, profile: null });
    } else if (action === 'show-login') {
      setState({ view: 'auth', authMode: 'login', error: '' });
    } else if (action === 'show-signup') {
      setState({ view: 'auth', authMode: 'signup', error: '' });
    } else if (action === 'show-forgot') {
      setState({ view: 'auth', authMode: 'forgot', error: '' });
    } else if (action === 'copy-link') {
      await navigator.clipboard.writeText(location.href);
      setState({ error: '' });
    } else if (action === 'toggle-privacy') {
      await api.toggleListPrivacy(S.list.id, btn.dataset.private !== 'true');
    } else if (action === 'toggle-status') {
      await api.toggleListStatus(S.list.id, btn.dataset.status === 'open' ? 'closed' : 'open');
    } else if (action === 'join-list') {
      await api.joinList(S.list.id, S.profile.display_name);
    } else if (action === 'edit-member') {
      setState({ inlineEdit: { type: 'member', id: btn.dataset.id } });
    } else if (action === 'remove-member') {
      setState({ inlineEdit: { type: 'confirm-remove-member', id: btn.dataset.id } });
    } else if (action === 'confirm-remove-member') {
      await api.deleteMember(btn.dataset.id);
      setState({ inlineEdit: null });
    } else if (action === 'cancel-inline') {
      setState({ inlineEdit: null });
    } else if (action === 'remove-expense') {
      await api.deleteExpense(btn.dataset.id);
    } else if (action === 'declare-settlement') {
      await api.declareSettlement(S.list.id, btn.dataset.from, btn.dataset.to, parseInt(btn.dataset.amount, 10));
    } else if (action === 'confirm-settlement') {
      await api.confirmSettlement(btn.dataset.id);
    } else if (action === 'add-friend') {
      const category = app.querySelector('#new-friend-category')?.value.trim();
      await api.addFriend(btn.dataset.id, category);
      await loadFriends();
    } else if (action === 'remove-friend') {
      await api.removeFriend(btn.dataset.id);
      await loadFriends();
    } else if (action === 'invite-friend-by-email') {
      const category = app.querySelector('#new-friend-category')?.value.trim();
      const email = btn.dataset.email;
      await api.inviteFriendByEmail(email, category);
      const appUrl = window.location.origin + import.meta.env.BASE_URL + '#inscription';
      const subject = encodeURIComponent('Invitation à rejoindre Les Bons Comptes');
      const body = encodeURIComponent(
        `Salut !\n\n${S.profile.display_name} t'invite à rejoindre "Les Bons Comptes" pour gérer vos dépenses partagées.\n\nCrée ton compte ici : ${appUrl}\n\nUtilise bien cette adresse email (${email}) à l'inscription pour être automatiquement ajouté à sa liste d'amis.`
      );
      window.location.href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`;
      await loadFriends();
    } else if (action === 'cancel-friend-invite') {
      await api.cancelFriendInvite(btn.dataset.id);
      await loadFriends();
    } else if (action === 'add-member-from-search') {
      await api.addMemberByProfile(S.list.id, btn.dataset.id, btn.dataset.name);
      setState({ memberSearchResults: [] });
    } else if (action === 'switch-home-tab') {
      setState({ homeTab: btn.dataset.tab });
    } else if (action === 'switch-list-tab') {
      setState({ listTab: btn.dataset.tab });
    }
  } catch (err) {
    setState({ error: friendlyError(err) });
  }
});

app.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  try {
    if (action === 'reassign-expense') {
      await api.reassignExpense(el.dataset.id, el.value);
    } else if (action === 'update-friend-category') {
      await api.updateFriendCategory(el.dataset.id, el.value);
      await loadFriends();
    } else if (action === 'update-list-category') {
      await api.updateListCategory(S.list.id, el.value);
    }
  } catch (err) {
    setState({ error: friendlyError(err) });
  }
});

const EMAIL_RE = /^\S+@\S+\.\S+$/;

let searchDebounce = null;
app.addEventListener('input', (e) => {
  const el = e.target.closest('[data-action="friend-search-input"], [data-action="member-search-input"]');
  if (!el) return;
  const action = el.dataset.action;
  const isFriendSearch = action === 'friend-search-input';
  const query = el.value;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    try {
      let patch;
      if (isFriendSearch && EMAIL_RE.test(query.trim())) {
        const profile = await api.findProfileByEmail(query.trim());
        patch = profile
          ? { friendSearchResults: [profile], friendSearchQuery: query, friendSearchNoMatch: false }
          : { friendSearchResults: [], friendSearchQuery: query, friendSearchNoMatch: true };
      } else {
        const results = await api.searchProfiles(query);
        patch = isFriendSearch
          ? { friendSearchResults: results, friendSearchQuery: query, friendSearchNoMatch: false }
          : { memberSearchResults: results };
      }
      setState(patch);
      // Le re-rendu complet recrée l'input : on restaure sa valeur, le focus et le curseur.
      const input = app.querySelector(`[data-action="${action}"]`);
      if (input) {
        input.value = query;
        input.focus();
        input.setSelectionRange(query.length, query.length);
      }
    } catch (err) {
      setState({ error: friendlyError(err) });
    }
  }, 300);
});

const ERROR_TRANSLATIONS = {
  'Invalid login credentials': 'Email ou mot de passe incorrect.',
  'User already registered': 'Un compte existe déjà avec cet email — connecte-toi plutôt.',
  'Email not confirmed': "Confirme d'abord ton adresse email (lien reçu à l'inscription).",
  'Password should be at least 6 characters': 'Le mot de passe doit contenir au moins 6 caractères.',
};

function friendlyError(err) {
  console.error(err);
  const msg = err?.message || '';
  return ERROR_TRANSLATIONS[msg] || msg || 'Une erreur est survenue.';
}

boot();

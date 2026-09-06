import './style.css';
import { supabase } from './supabase.js';
import * as api from './api.js';
import { computeBalances, computeTransactions, formatCents } from './balances.js';
import { extractTotalFromImage } from './ocr.js';

const app = document.getElementById('app');

const CATEGORIES = ['Anniversaire', 'Famille', 'Professionnel', 'Voyage', 'Autre'];

const LIST_TABS = [
  { key: 'apercu', label: '📊 Aperçu' },
  { key: 'participants', label: 'Participants' },
  { key: 'depenses', label: 'Dépenses' },
  { key: 'justificatifs', label: '📎 Justificatifs' },
  { key: 'soldes', label: 'Soldes' },
  { key: 'remboursements', label: 'Remboursements suggérés' },
];

const S = {
  session: null,
  profile: null,
  view: 'loading', // loading | auth | confirm-email | reset-sent | onboarding-name | home | list | profile | friends | add-friend-link
  authMode: 'login', // login | signup | forgot
  pendingEmail: '',
  error: '',
  profileNotice: '',
  friendsNotice: '',
  confirmDeleteAccount: false,
  lists: [],
  pendingListInvites: [],
  profileMenuOpen: false,
  list: null,
  listTab: 'apercu',
  members: [],
  memberProfiles: {}, // profile_id -> { display_name, avatar_url }
  memberSearchResults: [],
  expenses: [],
  expensePayers: [], // { id, expense_id, member_id, amount_cents }[]
  pendingReceipts: [],
  attributingReceiptId: null,
  settlements: [],
  friends: [],
  pendingInvites: [],
  friendSearchResults: [],
  friendSearchQuery: '',
  friendSearchNoMatch: false,
  friendLinkProfile: null,
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

function renderAvatar(url, name, size) {
  const cls = size === 'large' ? 'avatar-large' : 'avatar-mini';
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return url
    ? `<img class="${cls}" src="${escapeHtml(url)}" alt="" />`
    : `<span class="${cls} avatar-placeholder">${escapeHtml(initial)}</span>`;
}

function inviteLinkFor(profileId) {
  return `${window.location.origin}${import.meta.env.BASE_URL}#/ajouter/${profileId}`;
}

// ---------------- Boot ----------------

const LEGAL_VIEWS = { '#/mentions-legales': 'legal-mentions', '#/confidentialite': 'legal-privacy', '#/a-propos': 'about' };

async function boot() {
  window.addEventListener('hashchange', routeFromHash);
  if (LEGAL_VIEWS[location.hash]) {
    setState({ view: LEGAL_VIEWS[location.hash] });
    return;
  }
  const session = await api.getSession();
  // onAuthStateChange se déclenche aussi immédiatement avec la session déjà connue (pas
  // seulement sur un futur changement) : on ne rappelle donc PAS afterLogin() ici en plus,
  // pour éviter deux chargements concurrents de la même page au démarrage (particulièrement
  // visible sur une liste : le second appel désabonne le premier du temps réel en plein
  // chargement, et si l'un des deux échoue après l'autre, son erreur écrase le bon résultat).
  api.onAuthStateChange((session) => {
    S.session = session;
    if (session) afterLogin();
    else if (S.view !== 'reset-sent') setState({ view: 'auth', authMode: 'login', profile: null });
  });
  if (!session) {
    const authMode = location.hash === '#inscription' ? 'signup' : 'login';
    setState({ view: 'auth', authMode });
  }
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
  S.profileMenuOpen = false;
  if (LEGAL_VIEWS[location.hash]) {
    setState({ view: LEGAL_VIEWS[location.hash] });
    return;
  }
  const mList = location.hash.match(/^#\/list\/([a-f0-9-]+)(?:\/([a-z]+))?/i);
  const mAddFriend = location.hash.match(/^#\/ajouter\/([a-f0-9-]+)/i);
  if (location.hash === '#/profil') {
    await loadProfile();
  } else if (location.hash === '#/amis') {
    await loadFriends();
  } else if (mAddFriend) {
    await openAddFriendLink(mAddFriend[1]);
  } else if (mList) {
    await openList(mList[1], mList[2]);
  } else {
    await loadHome();
  }
}

async function fetchFriendsData() {
  const [friends, pendingInvites] = await Promise.all([api.listFriends(), api.listPendingFriendInvites()]);
  return { friends, pendingInvites };
}

// Recharge les données d'amis sans changer de vue — utilisé après une action (ajouter,
// retirer, catégoriser...) qui peut être déclenchée depuis la page Amis ou depuis le profil.
async function refreshFriends() {
  const { friends, pendingInvites } = await fetchFriendsData();
  setState({ friends, pendingInvites });
}

async function loadFriends() {
  if (S.unsubscribe) { S.unsubscribe(); S.unsubscribe = null; }
  const { friends, pendingInvites } = await fetchFriendsData();
  setState({
    view: 'friends',
    friends,
    pendingInvites,
    friendSearchResults: [],
    friendSearchQuery: '',
    friendSearchNoMatch: false,
    friendsNotice: '',
    error: '',
  });
}

async function loadProfile() {
  if (S.unsubscribe) { S.unsubscribe(); S.unsubscribe = null; }
  setState({ view: 'profile', error: '', profileNotice: '' });
}

async function openAddFriendLink(profileId) {
  if (S.unsubscribe) { S.unsubscribe(); S.unsubscribe = null; }
  try {
    const [card, friends] = await Promise.all([api.getPublicProfileCard(profileId), api.listFriends()]);
    setState({ view: 'add-friend-link', friendLinkProfile: card, friends, error: '' });
  } catch (e) {
    setState({ view: 'add-friend-link', friendLinkProfile: null, error: '' });
  }
}

async function loadHome() {
  if (S.unsubscribe) { S.unsubscribe(); S.unsubscribe = null; }
  const [lists, pendingListInvites] = await Promise.all([api.fetchMyLists(), api.getPendingListInvites()]);
  setState({ view: 'home', lists, pendingListInvites, list: null });
}

// Si deux appels à openList se chevauchent (ex. double déclenchement de la restauration de
// session au démarrage), seul le résultat du DERNIER appel en date doit s'appliquer — sinon
// le premier peut écraser le bon résultat du second après coup (ou l'inverse), y compris en
// cas d'erreur.
let listLoadToken = 0;

async function openList(listId, requestedTab) {
  const myToken = ++listLoadToken;
  if (S.unsubscribe) { S.unsubscribe(); S.unsubscribe = null; }
  try {
    const list = await api.getList(listId);
    const [members, expenses, expensePayers, pendingReceipts, settlements, memberProfilesArr] = await Promise.all([
      api.getMembers(listId),
      api.getExpenses(listId),
      api.getExpensePayers(listId),
      api.getPendingReceipts(listId),
      api.getSettlements(listId),
      api.getMemberProfiles(listId),
    ]);
    if (myToken !== listLoadToken) return;
    const memberProfiles = Object.fromEntries(memberProfilesArr.map((p) => [p.profile_id, p]));
    const listTab = LIST_TABS.some((t) => t.key === requestedTab) ? requestedTab : 'apercu';
    S.unsubscribe = api.subscribeToList(listId, () => refreshList(listId));
    setState({ view: 'list', list, members, expenses, expensePayers, pendingReceipts, settlements, memberProfiles, memberSearchResults: [], listTab });
    // replaceState (pas location.hash =) pour ne pas déclencher un second hashchange qui
    // relancerait tout le chargement ci-dessus une deuxième fois.
    history.replaceState(null, '', `#/list/${listId}/${listTab}`);
  } catch (e) {
    if (myToken !== listLoadToken) return;
    setState({ view: 'home', error: "Liste introuvable ou accès non autorisé." });
  }
}

async function refreshList(listId) {
  const [list, members, expenses, expensePayers, pendingReceipts, settlements, memberProfilesArr] = await Promise.all([
    api.getList(listId),
    api.getMembers(listId),
    api.getExpenses(listId),
    api.getExpensePayers(listId),
    api.getPendingReceipts(listId),
    api.getSettlements(listId),
    api.getMemberProfiles(listId),
  ]);
  const memberProfiles = Object.fromEntries(memberProfilesArr.map((p) => [p.profile_id, p]));
  setState({ list, members, expenses, expensePayers, pendingReceipts, settlements, memberProfiles });
}

// ---------------- Render ----------------

function render() {
  if (S.view === 'loading') {
    app.innerHTML = `<div class="center-screen">Chargement…</div>`;
    return;
  }
  let html;
  if (S.view === 'auth') html = renderAuth();
  else if (S.view === 'confirm-email') html = renderConfirmEmail();
  else if (S.view === 'reset-sent') html = renderResetSent();
  else if (S.view === 'account-deleted') html = renderAccountDeleted();
  else if (S.view === 'about') html = renderAboutPage();
  else if (S.view === 'legal-mentions') html = renderLegalMentions();
  else if (S.view === 'legal-privacy') html = renderLegalPrivacy();
  else if (S.view === 'onboarding-name') html = renderOnboarding();
  else if (S.view === 'profile') html = renderTopbar() + renderProfilePage();
  else if (S.view === 'friends') html = renderTopbar() + renderFriendsPage();
  else if (S.view === 'add-friend-link') html = renderTopbar() + renderAddFriendLink();
  else if (S.view === 'home') html = renderTopbar() + renderHome();
  else if (S.view === 'list') html = renderTopbar() + renderList();
  app.innerHTML = html + renderFooter();
}

function renderFooter() {
  const date = new Date(__BUILD_DATE__).toLocaleDateString('fr-FR');
  return `<div class="app-footer muted">Version ${__APP_VERSION__} · Dernière mise à jour le ${date}</div>`;
}

function renderTopbar() {
  const avatar = renderAvatar(S.profile?.avatar_url, S.profile?.display_name, 'mini');
  return `
    <div class="topbar">
      <a href="#/" class="brand">🧾 Les Bons Comptes</a>
      <div class="profile-menu-wrap">
        <button class="avatar-btn" data-action="toggle-profile-menu" title="Menu" aria-haspopup="true" aria-expanded="${S.profileMenuOpen ? 'true' : 'false'}">${avatar}</button>
        ${S.profileMenuOpen ? `
          <div class="profile-menu">
            <a href="#/" data-action="close-profile-menu">🧾 Mes listes</a>
            <a href="#/amis" data-action="close-profile-menu">👥 Mes amis</a>
            <a href="#/profil" data-action="close-profile-menu">👤 Mon profil</a>
            <a href="#/a-propos" data-action="close-profile-menu">ℹ️ À propos</a>
            <button data-action="logout">🚪 Se déconnecter</button>
          </div>
        ` : ''}
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

const AUTH_LEGAL_FOOTER = `
  <p class="legal-footer muted">
    <a href="#/a-propos">À propos</a> · <a href="#/mentions-legales">Mentions légales</a> · <a href="#/confidentialite">Confidentialité</a>
  </p>
`;

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
        ${AUTH_LEGAL_FOOTER}
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
          <input type="password" name="password" required minlength="8" placeholder="8 caractères minimum" />
          <button type="submit">Créer mon compte</button>
        </form>
        <button class="link-btn" data-action="show-login">J'ai déjà un compte</button>
        ${AUTH_LEGAL_FOOTER}
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
        ${AUTH_LEGAL_FOOTER}
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

function renderAccountDeleted() {
  return `
    <div class="center-screen">
      <div class="card auth-card">
        <h1>Compte supprimé</h1>
        <p class="muted">Ton compte a été anonymisé et la connexion définitivement bloquée. Merci d'avoir utilisé Les Bons Comptes.</p>
        <button class="link-btn" data-action="show-login">Retour à l'accueil</button>
      </div>
    </div>
  `;
}

function renderAboutPage() {
  const date = new Date(__BUILD_DATE__).toLocaleDateString('fr-FR');
  return `
    <div class="page legal-page">
      <h1>🧾 À propos de Les Bons Comptes</h1>
      <p class="muted">Version ${__APP_VERSION__} · Dernière mise à jour le ${date}</p>

      <p>Les Bons Comptes est une application pour gérer facilement les dépenses partagées entre amis, en famille ou en colocation : listes de dépenses, remboursements (même partiels), justificatifs (tickets de caisse, factures), et calcul automatique de qui doit quoi à qui.</p>

      <h2>Code source</h2>
      <p>Le code de cette application est visible publiquement sur GitHub : <a href="https://github.com/Acrotux/les-bons-comptes" target="_blank" rel="noopener">github.com/Acrotux/les-bons-comptes</a>.</p>

      <h2>Bibliothèques et services utilisés</h2>
      <ul>
        <li><a href="https://supabase.com" target="_blank" rel="noopener">Supabase</a> — base de données, authentification et stockage des fichiers.</li>
        <li><a href="https://vite.dev" target="_blank" rel="noopener">Vite</a> — outil de développement et de construction du site.</li>
        <li><a href="https://tesseract.projectnaptha.com" target="_blank" rel="noopener">Tesseract.js</a> — lecture automatique du montant sur un ticket/facture (OCR libre et open source, exécuté entièrement dans ton navigateur).</li>
        <li><a href="https://fonts.google.com/specimen/IBM+Plex+Sans" target="_blank" rel="noopener">IBM Plex</a> (Google Fonts) — polices de caractères.</li>
        <li><a href="https://pages.github.com" target="_blank" rel="noopener">GitHub Pages</a> — hébergement du site.</li>
      </ul>

      <h2>En savoir plus</h2>
      <p><a href="#/mentions-legales">Mentions légales</a> · <a href="#/confidentialite">Politique de confidentialité</a></p>
      <p class="muted">Une question, un bug à signaler ? <a href="mailto:cartoux.j@gmail.com">cartoux.j@gmail.com</a></p>

      <button class="link-btn" data-action="legal-back">&larr; Retour</button>
    </div>
  `;
}

function renderLegalMentions() {
  return `
    <div class="page legal-page">
      <h1>Mentions légales</h1>
      <p><strong>Éditeur du site</strong><br />Acrotux, à titre personnel et non commercial.<br />Contact : <a href="mailto:cartoux.j@gmail.com">cartoux.j@gmail.com</a></p>
      <p><strong>Hébergement des fichiers du site</strong><br />GitHub Pages (GitHub, Inc., 88 Colin P Kelly Jr St, San Francisco, CA 94107, États-Unis).</p>
      <p><strong>Hébergement des données</strong><br />Supabase (base de données et fichiers), région Union Européenne (Irlande).</p>
      <p><strong>Directeur de la publication</strong><br />Acrotux.</p>
      <p>Voir aussi la <a href="#/confidentialite">politique de confidentialité</a>.</p>
      <button class="link-btn" data-action="legal-back">&larr; Retour</button>
    </div>
  `;
}

function renderLegalPrivacy() {
  return `
    <div class="page legal-page">
      <h1>Politique de confidentialité</h1>

      <h2>Données collectées</h2>
      <p>Pseudo, adresse email, mot de passe (stocké de façon chiffrée, jamais en clair), photo de profil optionnelle, ainsi que les données que tu saisis dans l'application : listes de dépenses, montants, participants, remboursements, et les justificatifs (tickets de caisse, factures) que tu choisis de joindre à une dépense. Les participants sans compte que tu ajoutes à une liste peuvent avoir un nom et une adresse email associés.</p>

      <h2>Finalités</h2>
      <p>Ces données servent uniquement à faire fonctionner l'application : authentification, gestion des listes de dépenses partagées, calcul des soldes et des remboursements.</p>

      <h2>Qui voit quoi</h2>
      <p>Ton pseudo et ta photo de profil sont visibles par les autres participants des listes auxquelles tu appartiens. Les dépenses, remboursements et justificatifs d'une liste sont visibles uniquement par ses participants (les justificatifs sont stockés dans un espace privé, jamais public). Ton adresse email n'est jamais affichée publiquement ni partagée avec les autres utilisateurs, sauf si tu choisis toi-même de la renseigner comme contact d'un participant.</p>

      <h2>Sous-traitants</h2>
      <p><strong>Supabase</strong> (base de données, authentification, stockage des photos et justificatifs) — hébergé dans l'Union Européenne.<br /><strong>GitHub Pages</strong> (hébergement des fichiers statiques du site, aucune donnée personnelle n'y est stockée).</p>

      <h2>Conservation</h2>
      <p>Tes données sont conservées tant que ton compte existe. Les dépenses/remboursements déjà enregistrés dans une liste partagée peuvent rester visibles aux autres participants après la suppression de ton compte, mais sans ton nom ni ta photo (anonymisés).</p>

      <h2>Stockage local du navigateur</h2>
      <p>L'application utilise le stockage local de ton navigateur (localStorage) pour maintenir ta connexion. Aucun cookie publicitaire ou traceur tiers n'est utilisé.</p>

      <h2>Tes droits</h2>
      <p>Tu peux à tout moment accéder à tes données, les corriger, ou supprimer ton compte directement depuis la page « Mon profil » (section « Zone dangereuse »). Pour toute autre demande (portabilité, opposition, question), contacte <a href="mailto:cartoux.j@gmail.com">cartoux.j@gmail.com</a>.</p>

      <button class="link-btn" data-action="legal-back">&larr; Retour</button>
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
  const avatar = renderAvatar(p?.avatar_url, p?.display_name, 'large');

  return `
    <div class="page">
      <h1>Mon profil</h1>
      ${S.profileNotice ? `<div class="banner notice">${escapeHtml(S.profileNotice)}</div>` : ''}

      <div class="card">
        <h2>Photo de profil</h2>
        <div class="avatar-row">
          ${avatar}
          <form data-action="upload-avatar" class="avatar-form">
            <input type="file" name="avatar" accept="image/png,image/jpeg,image/webp,image/gif" required />
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
          <input type="password" name="password" required minlength="8" placeholder="Nouveau mot de passe (8 caractères min.)" />
          <button type="submit">Changer le mot de passe</button>
        </form>
      </div>

      <div class="card danger-zone">
        <h2>Zone dangereuse</h2>
        ${S.confirmDeleteAccount ? `
          <p>Cette action est irréversible : ton profil sera anonymisé, tes amis et invitations supprimés, et la connexion à ce compte définitivement bloquée. Les dépenses déjà enregistrées resteront visibles aux autres participants, sans ton nom.</p>
          <form data-action="delete-account-confirm">
            <label>Tape SUPPRIMER pour confirmer</label>
            <input type="text" name="confirmation" required placeholder="SUPPRIMER" />
            <button type="submit" class="danger-btn">Supprimer définitivement mon compte</button>
            <button type="button" data-action="cancel-delete-account">Annuler</button>
          </form>
        ` : `
          <button data-action="ask-delete-account" class="danger-btn">Supprimer mon compte</button>
        `}
      </div>

      <a class="link-btn" href="#/">&larr; Retour</a>
    </div>
  `;
}

// Recherche/ajout, lien d'invitation, invitations en attente et liste par catégorie —
// utilisé aussi bien sur la page dédiée (#/amis) que dans la page de profil.
function renderFriendsSections() {
  const grouped = {};
  for (const f of S.friends) {
    (grouped[f.category] ||= []).push(f);
  }
  const categories = Object.keys(grouped).sort();
  const ownCategories = [...new Set(S.friends.map((f) => f.category))].sort();
  const link = inviteLinkFor(S.profile.id);

  return `
    ${S.friendsNotice ? `<div class="banner notice">${escapeHtml(S.friendsNotice)}</div>` : ''}

    <datalist id="friend-category-options">
      ${ownCategories.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('')}
    </datalist>

    <div class="card">
      <h3>Ajouter un ami</h3>
      <p class="muted">Cherche un pseudo ou un email déjà inscrit, ou partage ton lien d'invitation ci-dessous.</p>
      <div class="field-stack">
        <input type="text" data-action="friend-search-input" placeholder="Rechercher un pseudo ou un email…" />
        <label class="muted">Catégorie pour ce nouvel ami (optionnel, tu peux créer la tienne)</label>
        <input type="text" id="new-friend-category" list="friend-category-options" placeholder="Ex : Famille, Collègues, Rugby…" />
      </div>
      ${S.friendSearchResults.length ? `
        <ul class="search-results">
          ${S.friendSearchResults.map((p) => `
            <li>
              ${renderAvatar(p.avatar_url, p.display_name, 'mini')}
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

    <div class="card">
      <h3>Ton lien d'invitation</h3>
      <p class="muted">Partage ce lien : la personne qui l'ouvre (après s'être connectée) peut t'ajouter en ami directement, sans connaître ton email.</p>
      <div class="invite-link-row">
        <input type="text" readonly value="${escapeHtml(link)}" id="friends-invite-link" />
        <button type="button" data-action="copy-invite-link" data-target="friends-invite-link">Copier</button>
      </div>
    </div>

    ${S.pendingInvites.length ? `
      <h3>Invitations en attente</h3>
      <ul class="member-list">
        ${S.pendingInvites.map((inv) => `
          <li>
            <span>${escapeHtml(inv.email)}</span>
            <span class="badge muted">en attente</span>
            <button class="icon-btn" data-action="cancel-friend-invite" data-id="${inv.id}" title="Annuler l'invitation">🗑</button>
          </li>
        `).join('')}
      </ul>
    ` : ''}

    ${categories.length ? categories.map((cat) => `
      <h3>${escapeHtml(cat)}</h3>
      <ul class="member-list">
        ${grouped[cat].map((f) => `
          <li>
            ${renderAvatar(f.avatar_url, f.display_name, 'mini')}
            <span>${escapeHtml(f.display_name)}</span>
            <input type="text" list="friend-category-options" data-action="update-friend-category" data-id="${f.id}" value="${escapeHtml(f.category)}" />
            <button class="icon-btn" data-action="remove-friend" data-id="${f.id}" title="Retirer cet ami">🗑</button>
          </li>
        `).join('')}
      </ul>
    `).join('') : '<p class="muted">Aucun ami ajouté pour l\'instant.</p>'}
  `;
}

function renderFriendsPage() {
  return `
    <div class="page">
      <h1>Mes amis</h1>
      ${renderFriendsSections()}
    </div>
  `;
}

function renderAddFriendLink() {
  const p = S.friendLinkProfile;
  if (!p) {
    return `
      <div class="page">
        <div class="card"><p class="muted">Ce lien d'invitation n'est plus valide.</p><a class="link-btn" href="#/">Retour à l'accueil</a></div>
      </div>
    `;
  }
  const isMe = p.id === S.session.user.id;
  const alreadyFriend = S.friends.some((f) => f.friend_id === p.id);
  return `
    <div class="page">
      <div class="card" style="text-align:center;">
        ${renderAvatar(p.avatar_url, p.display_name, 'large')}
        <h2>${escapeHtml(p.display_name)}</h2>
        ${isMe ? `
          <p class="muted">C'est ton propre lien d'invitation — partage-le à un ami pour qu'il t'ajoute !</p>
        ` : alreadyFriend ? `
          <p class="muted">${escapeHtml(p.display_name)} est déjà dans tes amis.</p>
        ` : `
          <p class="muted">t'invite à rejoindre sa liste d'amis sur Les Bons Comptes.</p>
          <button data-action="add-friend-from-link" data-id="${p.id}" data-name="${escapeHtml(p.display_name)}">Ajouter ${escapeHtml(p.display_name)} en ami</button>
        `}
        <a class="link-btn" href="#/">Retour à l'accueil</a>
      </div>
    </div>
  `;
}

function renderListCard(l) {
  return `
    <a class="card list-card" href="#/list/${l.id}">
      <div class="list-card-title">${escapeHtml(l.name)}</div>
      <div class="list-card-meta">
        <span class="badge ${l.status}">${l.status === 'open' ? 'ouverte' : 'clôturée'}</span>
        <span class="badge muted">${l.is_private ? 'privée' : 'publique'}</span>
        ${l.category ? `<span class="badge muted">${escapeHtml(l.category)}</span>` : ''}
      </div>
    </a>
  `;
}

// Toutes les listes en cours et l'historique, sans filtre par catégorie — utilisé dans la
// page de profil comme sur la page d'accueil.
function renderMyListsSection() {
  const open = S.lists.filter((l) => l.status === 'open');
  const closed = S.lists.filter((l) => l.status === 'closed');
  return `
    <h3>Listes en cours</h3>
    <div class="list-grid">${open.length ? open.map(renderListCard).join('') : '<p class="muted">Aucune liste en cours.</p>'}</div>
    ${closed.length ? `<h3>Historique</h3><div class="list-grid">${closed.map(renderListCard).join('')}</div>` : '<p class="muted">Aucune liste clôturée pour l\'instant.</p>'}
  `;
}

function renderHome() {
  return `
    <div class="page">
      ${S.pendingListInvites.length ? `
        <div class="card">
          <h2>Invitations à rejoindre une liste</h2>
          <ul class="member-list">
            ${S.pendingListInvites.map((inv) => `
              <li>
                <span>${escapeHtml(inv.list_name)}</span>
                <span class="muted">invité par ${escapeHtml(inv.invited_by_name || '?')}</span>
                <button data-action="accept-list-invite" data-id="${inv.member_id}">Accepter</button>
                <button class="icon-btn" data-action="decline-list-invite" data-id="${inv.member_id}">Refuser</button>
              </li>
            `).join('')}
          </ul>
        </div>
      ` : ''}

      <div class="card">
        <h2>Nouvelle liste</h2>
        <p class="muted">Une liste privée n'est visible que par les personnes que tu y invites. Une liste publique peut être rejointe par toute personne connectée qui a le lien.</p>
        <form data-action="create-list" class="create-list-form">
          <input type="text" name="name" required placeholder="Ex : Week-end à Lyon" />
          <select name="category">
            <option value="">Sans catégorie</option>
            ${CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
          </select>
          <label class="checkbox"><input type="checkbox" name="isPrivate" checked /> Privée (accessible seulement par invitation)</label>
          <button type="submit">Créer</button>
        </form>
      </div>

      ${renderMyListsSection()}
    </div>
  `;
}

function renderList() {
  const list = S.list;
  const uid = S.session.user.id;
  const isCreator = list.created_by === uid;
  const myPendingInvite = S.members.find((m) => m.profile_id === uid && m.status === 'invited');
  const myMember = S.members.find((m) => m.profile_id === uid && m.status === 'active');
  const isMember = !!myMember;
  const isAdmin = isCreator || (myMember && myMember.is_co_admin);

  const { total, balances, memberIds } = computeBalances(S.members, S.expensePayers, S.settlements);
  const { balances: grossBalances } = computeBalances(S.members, S.expensePayers, []);
  const transactions = computeTransactions(balances, memberIds);

  const payersByExpense = {};
  for (const p of S.expensePayers) {
    (payersByExpense[p.expense_id] ||= []).push(p);
  }

  const activeTab = LIST_TABS.some((t) => t.key === S.listTab) ? S.listTab : 'apercu';

  let tabContent;
  if (activeTab === 'apercu') {
    tabContent = renderListOverview(memberIds, balances, grossBalances);
  } else if (activeTab === 'participants') {
    tabContent = `
      <div class="card">
        <h2>Participants</h2>
        <p class="muted">👑 le créateur de la liste, 🥈 un co-administrateur qu'il a nommé (mêmes droits de gestion, sauf clôturer la liste).</p>
        <ul class="member-list">
          ${S.members.map((m) => renderMember(m, isCreator, isAdmin)).join('')}
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
                ${renderAvatar(p.avatar_url, p.display_name, 'mini')}
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
          ${S.expenses.map((e) => renderExpense(e, uid, isAdmin, payersByExpense[e.id] || [])).join('') || '<p class="muted">Aucune dépense pour l\'instant.</p>'}
        </ul>
        ${isMember ? renderExpenseForm() : ''}
      </div>
    `;
  } else if (activeTab === 'justificatifs') {
    tabContent = isMember
      ? renderPendingReceiptsCard(uid, isAdmin)
      : '<p class="muted">Rejoins la liste pour envoyer ou attribuer des justificatifs.</p>';
  } else if (activeTab === 'soldes') {
    tabContent = `
      <div class="card">
        <h2>Soldes</h2>
        <p class="muted">Ce que chacun a payé, comparé à sa part équitable du total.</p>
        <ul class="balance-list">
          ${memberIds.map((id) => renderBalance(id, balances[id])).join('')}
        </ul>
      </div>
    `;
  } else {
    tabContent = `
      <div class="card">
        <h2>Remboursements suggérés</h2>
        <p class="muted">Le plus petit nombre de virements pour que tout le monde soit à jour.</p>
        ${transactions.length ? `<ul class="tx-list">${transactions.map((t) => renderTransaction(t, myMember)).join('')}</ul>` : '<p class="muted">Tout le monde est à jour 🎉</p>'}
        ${renderPendingSettlements(myMember)}
        ${isMember ? `
          <h3>Déclarer un remboursement (montant libre, aussi partiel)</h3>
          <p class="muted">Seule la personne qui reçoit peut ensuite confirmer qu'elle a bien été remboursée, en tout ou en partie.</p>
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
          ${isAdmin ? `
            <select data-action="update-list-category">
              <option value="">Sans catégorie</option>
              ${CATEGORIES.map((c) => `<option value="${c}" ${c === list.category ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          ` : list.category ? `<span class="badge muted">${escapeHtml(list.category)}</span>` : ''}
          <button data-action="copy-link">Copier le lien</button>
          ${isAdmin ? `<button data-action="toggle-privacy" data-private="${list.is_private}">${list.is_private ? 'Rendre publique' : 'Rendre privée'}</button>` : ''}
          ${isCreator ? `<button data-action="toggle-status" data-status="${list.status}">${list.status === 'open' ? 'Clôturer' : 'Rouvrir'}</button>` : ''}
        </div>
      </div>

      ${list.status === 'closed' ? renderSummaryMailto(list, memberIds, balances) : ''}

      ${myPendingInvite ? `
        <div class="card">
          <p>Tu as été invité à rejoindre cette liste.</p>
          <button data-action="accept-list-invite" data-id="${myPendingInvite.id}">Accepter</button>
          <button data-action="decline-list-invite" data-id="${myPendingInvite.id}">Refuser</button>
        </div>
      ` : !isMember && !list.is_private ? `
        <div class="card">
          <p>Tu n'es pas encore participant de cette liste.</p>
          <button data-action="join-list">Rejoindre la liste</button>
        </div>
      ` : ''}

      <div class="tabs">
        ${LIST_TABS.map((t) => `<button class="tab ${t.key === activeTab ? 'active' : ''}" data-action="switch-list-tab" data-tab="${t.key}">${escapeHtml(t.label)}</button>`).join('')}
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

  const tile = (icon, value, label) => `<div class="card stat-tile"><div class="stat-icon">${icon}</div><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;

  return `
    <div class="stat-grid">
      ${tile('💶', formatCents(totalToReimburse), 'Montant total à rembourser')}
      ${tile('⏳', formatCents(remaining), 'Montant restant à rembourser')}
      ${tile('✅', formatCents(alreadyReimbursed), 'Montant déjà remboursé')}
      ${tile('👥', memberIds.length, 'Participants dans la liste')}
      ${tile('🔴', debtorsCount, "N'ont pas encore remboursé leurs dettes")}
      ${tile('🟢', settledDebtorsCount, 'Ont remboursé leurs dettes')}
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
  const img = renderAvatar(profile?.avatar_url, m.display_name, 'mini');
  const crown = isCreator
    ? '<span class="crown crown-gold" title="Créateur de la liste">👑</span>'
    : m.is_co_admin
      ? '<span class="crown crown-silver" title="Co-administrateur">👑</span>'
      : '';
  return `<span class="avatar-wrap">${img}${crown}</span>`;
}

function renderMember(m, isCreator, isAdmin) {
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
  const isOwnRow = m.profile_id && m.profile_id === S.list.created_by;
  const canPromote = isCreator && m.profile_id && !isOwnRow && m.status === 'active';
  const promotionHint = isCreator && !isOwnRow && !canPromote
    ? (!m.profile_id
        ? 'doit créer un compte pour devenir co-admin'
        : m.status === 'invited'
          ? 'doit accepter l\'invitation pour devenir co-admin'
          : '')
    : '';
  return `
    <li>
      ${renderMemberAvatar(m)}
      <span>${escapeHtml(m.display_name)}</span>
      ${m.is_co_admin ? '<span class="badge muted">co-admin</span>' : ''}
      ${!m.profile_id ? '<span class="badge muted">en attente</span>' : ''}
      ${m.profile_id && m.status === 'invited' ? '<span class="badge muted">invité·e, pas encore accepté</span>' : ''}
      ${m.email ? `<a class="mail-link" href="mailto:${escapeHtml(m.email)}">✉</a>` : '<span class="badge muted">pas d\'e-mail</span>'}
      ${canPromote ? `<button class="icon-btn" data-action="toggle-co-admin" data-id="${m.id}" data-value="${!m.is_co_admin}">${m.is_co_admin ? 'Retirer co-admin' : 'Nommer co-admin'}</button>` : ''}
      ${promotionHint ? `<span class="muted hint">(${promotionHint})</span>` : ''}
      ${isAdmin ? `<button class="icon-btn" data-action="edit-member" data-id="${m.id}" title="Modifier ce participant">✎</button>` : ''}
      ${isAdmin ? `<button class="icon-btn" data-action="remove-member" data-id="${m.id}" title="Retirer ce participant">🗑</button>` : ''}
    </li>
  `;
}

function payerRowHtml(selectedMemberId, amountCents) {
  const amountValue = amountCents != null ? (amountCents / 100).toFixed(2) : '';
  return `
    <div class="payer-row">
      <select name="payerMember">
        ${S.members.map((m) => `<option value="${m.id}" ${m.id === selectedMemberId ? 'selected' : ''}>${escapeHtml(m.display_name)}</option>`).join('')}
      </select>
      <input type="number" name="payerAmount" required min="0.01" step="0.01" placeholder="Montant €" value="${amountValue}" />
      <button type="button" class="icon-btn" data-action="remove-payer-row" title="Retirer ce payeur">🗑</button>
    </div>
  `;
}

// Si la même personne a été sélectionnée sur plusieurs lignes payeur (par erreur ou pour
// cumuler), on fusionne au lieu de laisser la contrainte d'unicité échouer en base.
function mergedPayersFromForm(fd) {
  const payerMembers = fd.getAll('payerMember');
  const payerAmounts = fd.getAll('payerAmount');
  const payersByMember = new Map();
  payerMembers.forEach((memberId, i) => {
    const cents = Math.round(parseFloat(payerAmounts[i]) * 100);
    payersByMember.set(memberId, (payersByMember.get(memberId) || 0) + cents);
  });
  return [...payersByMember].map(([member_id, amount_cents]) => ({ member_id, amount_cents }));
}

// Manipule le DOM directement (pas de setState) pour ne pas effacer ce que l'utilisateur a
// déjà tapé ailleurs dans le formulaire (libellé...) pendant que l'OCR tourne en arrière-plan.
async function handleReceiptFileOcr(input) {
  const file = input.files?.[0];
  const form = input.closest('form');
  const statusEl = form?.querySelector('[data-ocr-status]');
  if (!file || !statusEl) return;
  if (!file.type.startsWith('image/')) { statusEl.textContent = ''; return; }
  statusEl.textContent = '🔍 Analyse automatique du montant en cours…';
  try {
    const cents = await extractTotalFromImage(file);
    if (!document.body.contains(statusEl)) return;
    const amountInput = form.querySelector('input[name="payerAmount"]');
    if (cents != null && amountInput && !amountInput.value) {
      amountInput.value = (cents / 100).toFixed(2);
      statusEl.textContent = "✓ Montant détecté automatiquement — vérifie qu'il est correct.";
    } else if (cents != null) {
      statusEl.textContent = `Montant détecté sur le ticket (${formatCents(cents)}), mais tu as déjà renseigné le tien.`;
    } else {
      statusEl.textContent = 'Montant non détecté automatiquement, renseigne-le toi-même.';
    }
  } catch (err) {
    console.error(err);
    if (document.body.contains(statusEl)) statusEl.textContent = "Impossible d'analyser le ticket automatiquement.";
  }
}

// Même principe pour un justificatif déjà envoyé (attribution) : l'image est récupérée via
// une URL signée plutôt qu'un File local.
async function runReceiptOcr(receiptId, storagePath) {
  const form = () => app.querySelector(`form[data-action="attribute-receipt"][data-id="${receiptId}"]`);
  const statusEl = () => form()?.querySelector('[data-ocr-status]');
  if (statusEl()) statusEl().textContent = '🔍 Analyse automatique du montant en cours…';
  try {
    const url = await api.getReceiptSignedUrl(storagePath);
    const cents = await extractTotalFromImage(url);
    if (S.attributingReceiptId !== receiptId) return; // formulaire fermé/changé entre-temps
    const amountInput = form()?.querySelector('input[name="payerAmount"]');
    if (cents != null && amountInput && !amountInput.value) {
      amountInput.value = (cents / 100).toFixed(2);
      if (statusEl()) statusEl().textContent = "✓ Montant détecté automatiquement — vérifie qu'il est correct.";
    } else if (cents != null) {
      if (statusEl()) statusEl().textContent = `Montant détecté sur le ticket (${formatCents(cents)}), mais tu as déjà renseigné le tien.`;
    } else if (statusEl()) {
      statusEl().textContent = 'Montant non détecté automatiquement, renseigne-le toi-même.';
    }
  } catch (err) {
    console.error(err);
    if (S.attributingReceiptId === receiptId && statusEl()) {
      statusEl().textContent = "Impossible d'analyser le ticket automatiquement.";
    }
  }
}

function renderExpenseForm() {
  return `
    <form data-action="add-expense" class="expense-form">
      <input type="text" name="label" required placeholder="Libellé (ex : Courses)" />
      <div class="payer-rows">${payerRowHtml()}</div>
      <button type="button" class="link-btn" data-action="add-payer-row">+ Payé par plusieurs personnes (montants différents)</button>
      <label class="muted">Justificatif (ticket de caisse, facture) — optionnel
        <input type="file" name="receipt" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" data-action="receipt-file-input" />
      </label>
      <p class="muted hint" data-ocr-status></p>
      <button type="submit">Ajouter la dépense</button>
    </form>
  `;
}

function renderExpense(e, uid, isAdmin, payers) {
  const canManage = e.added_by === uid || isAdmin;

  if (S.inlineEdit && S.inlineEdit.type === 'expense' && S.inlineEdit.id === e.id) {
    return `
      <li class="expense-item expense-item-editing">
        <form data-action="edit-expense-inline" data-id="${e.id}" class="expense-form">
          <input type="text" name="label" required value="${escapeHtml(e.label)}" placeholder="Libellé" />
          <div class="payer-rows">
            ${(payers.length ? payers.map((p) => payerRowHtml(p.member_id, p.amount_cents)) : [payerRowHtml()]).join('')}
          </div>
          <button type="button" class="link-btn" data-action="add-payer-row">+ Ajouter un payeur</button>
          ${e.receipt_url ? `<label class="checkbox"><input type="checkbox" name="removeReceipt" /> Retirer le justificatif actuel</label>` : ''}
          <label class="muted">${e.receipt_url ? 'Remplacer le justificatif' : 'Justificatif (ticket de caisse, facture)'} — optionnel
            <input type="file" name="receipt" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" data-action="receipt-file-input" />
          </label>
          <p class="muted hint" data-ocr-status></p>
          <div class="inline-edit-actions">
            <button type="submit">Enregistrer</button>
            <button type="button" data-action="cancel-inline">Annuler</button>
          </div>
        </form>
      </li>
    `;
  }

  const singlePayer = payers.length === 1;
  const payerHtml = payers.length === 0
    ? '<span class="muted">?</span>'
    : singlePayer
      ? (isAdmin ? `
          <select data-action="reassign-expense-payer" data-id="${payers[0].id}" class="reassign-select">
            ${S.members.map((m) => `<option value="${m.id}" ${m.id === payers[0].member_id ? 'selected' : ''}>${escapeHtml(m.display_name)}</option>`).join('')}
          </select>
        ` : `<strong>${escapeHtml(nameOf(payers[0].member_id))}</strong>`)
      : `<span class="payer-breakdown">${payers.map((p) => `${escapeHtml(nameOf(p.member_id))} (${formatCents(p.amount_cents)})`).join(', ')}</span>`;
  return `
    <li class="expense-item">
      <span class="expense-label">${escapeHtml(e.label)}</span>
      <span class="expense-amount">${formatCents(e.amount_cents)}</span>
      <span class="expense-payer">payé par ${payerHtml}</span>
      ${e.receipt_url ? `<button class="icon-btn" data-action="view-receipt" data-path="${escapeHtml(e.receipt_url)}" title="Aperçu">📎 Aperçu</button>` : ''}
      ${canManage ? `<button class="icon-btn" data-action="edit-expense" data-id="${e.id}" title="Modifier cette dépense">✎</button>` : ''}
      ${canManage ? `<button class="icon-btn" data-action="remove-expense" data-id="${e.id}" title="Supprimer cette dépense">🗑</button>` : ''}
    </li>
  `;
}

function renderPendingReceiptsCard(uid, isAdmin) {
  return `
    <div class="card">
      <h2>Justificatifs en attente</h2>
      <p class="muted">Envoie un ou plusieurs tickets/factures maintenant, tu pourras les attribuer à une dépense (libellé, payeur, montant) plus tard, un par un.</p>
      <form data-action="upload-pending-receipts">
        <input type="text" name="label" placeholder="Libellé (optionnel, ex : Courses du 6 septembre)" />
        <input type="file" name="receipts" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" multiple required />
        <button type="submit">Envoyer</button>
      </form>
      ${S.pendingReceipts.length ? `
        <ul class="member-list">
          ${S.pendingReceipts.map((r) => renderPendingReceipt(r, uid, isAdmin)).join('')}
        </ul>
      ` : ''}
    </div>
  `;
}

function renderPendingReceipt(r, uid, isAdmin) {
  const canManage = r.uploaded_by === uid || isAdmin;
  if (S.attributingReceiptId === r.id) {
    return `
      <li>
        <form data-action="attribute-receipt" data-id="${r.id}" class="expense-form">
          <input type="text" name="label" required placeholder="Libellé (ex : Courses)" value="${escapeHtml(r.label || '')}" />
          <div class="payer-rows">${payerRowHtml()}</div>
          <button type="button" class="link-btn" data-action="add-payer-row">+ Payé par plusieurs personnes (montants différents)</button>
          <p class="muted hint" data-ocr-status></p>
          <div class="inline-edit-actions">
            <button type="submit">Créer la dépense</button>
            <button type="button" data-action="cancel-attribute-receipt">Annuler</button>
          </div>
        </form>
      </li>
    `;
  }
  const date = new Date(r.created_at).toLocaleDateString('fr-FR');
  return `
    <li>
      <button class="icon-btn" data-action="view-receipt" data-path="${escapeHtml(r.storage_path)}" title="Aperçu">📎 Aperçu</button>
      <span>${r.label ? escapeHtml(r.label) : '<span class="muted">(sans libellé)</span>'}</span>
      <span class="muted">ajouté le ${date}</span>
      <button data-action="start-attribute-receipt" data-id="${r.id}" data-path="${escapeHtml(r.storage_path)}">Attribuer</button>
      ${canManage ? `<button class="icon-btn" data-action="discard-pending-receipt" data-id="${r.id}" data-path="${escapeHtml(r.storage_path)}" title="Supprimer sans attribuer">🗑</button>` : ''}
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
  const canRemind = myMember && myMember.id !== t.from;
  const debtor = S.members.find((m) => m.id === t.from);
  return `
    <li class="tx-item">
      <span>${escapeHtml(nameOf(t.from))} → ${escapeHtml(nameOf(t.to))} : <strong>${formatCents(t.amount)}</strong></span>
      <span class="tx-actions">
        ${canDeclare ? `<button data-action="declare-settlement" data-from="${t.from}" data-to="${t.to}" data-amount="${t.amount}">J'ai remboursé</button>` : ''}
        ${canRemind && debtor?.email ? `<button class="icon-btn" data-action="remind-debtor" data-email="${escapeHtml(debtor.email)}" data-name="${escapeHtml(debtor.display_name)}" data-amount="${t.amount}" title="Relancer par email">✉️ Relancer</button>` : ''}
      </span>
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
  const fd = new FormData(form);
  const data = Object.fromEntries(fd.entries());

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
      const payers = mergedPayersFromForm(fd);
      const receiptFile = form.receipt?.files?.[0] || null;
      await api.addExpense(S.list.id, data.label, payers, receiptFile);
      form.reset();
    } else if (action === 'edit-expense-inline') {
      const expenseId = form.dataset.id;
      const payers = mergedPayersFromForm(fd);
      const newMemberIds = new Set(payers.map((p) => p.member_id));
      const payerRowIdsToRemove = S.expensePayers
        .filter((p) => p.expense_id === expenseId && !newMemberIds.has(p.member_id))
        .map((p) => p.id);
      const receiptFile = form.receipt?.files?.[0] || null;
      await api.updateExpense(expenseId, S.list.id, data.label, payers, payerRowIdsToRemove, receiptFile, !!data.removeReceipt);
      setState({ inlineEdit: null });
    } else if (action === 'upload-pending-receipts') {
      const files = [...form.receipts.files];
      await Promise.all(files.map((file) => api.uploadPendingReceipt(S.list.id, file, data.label)));
      form.reset();
    } else if (action === 'attribute-receipt') {
      const receiptId = form.dataset.id;
      const payers = mergedPayersFromForm(fd);
      await api.attributeReceipt(receiptId, S.list.id, data.label, payers);
      setState({ attributingReceiptId: null });
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
    } else if (action === 'delete-account-confirm') {
      if (data.confirmation !== 'SUPPRIMER') {
        setState({ error: 'Tape exactement SUPPRIMER pour confirmer.' });
      } else {
        await api.deleteAccount();
        await api.signOut();
        setState({ view: 'account-deleted', session: null, profile: null, confirmDeleteAccount: false });
      }
    }
  } catch (err) {
    setState({ error: friendlyError(err) });
  }
});

app.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  // Actions purement locales sur un formulaire en cours de saisie : pas de re-rendu, pour ne
  // pas perdre ce que l'utilisateur a déjà tapé dans les autres champs.
  if (btn.dataset.action === 'add-payer-row') {
    btn.closest('form').querySelector('.payer-rows').insertAdjacentHTML('beforeend', payerRowHtml());
    return;
  }
  if (btn.dataset.action === 'remove-payer-row') {
    const rows = btn.closest('form').querySelectorAll('.payer-row');
    if (rows.length > 1) btn.closest('.payer-row').remove();
    return;
  }
  if (btn.dataset.action === 'copy-invite-link') {
    const input = document.getElementById(btn.dataset.target);
    await navigator.clipboard.writeText(input.value);
    input.select();
    return;
  }
  if (btn.dataset.action === 'cancel-inline') {
    setState({ inlineEdit: null });
    return;
  }
  if (btn.dataset.action === 'cancel-attribute-receipt') {
    setState({ attributingReceiptId: null });
    return;
  }
  if (btn.dataset.action === 'toggle-profile-menu') {
    setState({ profileMenuOpen: !S.profileMenuOpen });
    return;
  }
  if (btn.dataset.action === 'close-profile-menu') {
    // On navigue nous-mêmes puis on ferme le menu : re-rendre l'app tout de suite (via
    // setState) détache ce lien du DOM avant que le navigateur n'ait suivi son href, ce qui
    // annule silencieusement la navigation par défaut.
    e.preventDefault();
    const href = btn.getAttribute('href');
    setState({ profileMenuOpen: false });
    if (href) location.hash = href;
    return;
  }

  if (btn.closest('form')) return;
  const action = btn.dataset.action;

  try {
    if (action === 'logout') {
      await api.signOut();
      setState({ view: 'auth', authMode: 'login', session: null, profile: null, profileMenuOpen: false });
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
    } else if (action === 'toggle-co-admin') {
      await api.setCoAdmin(btn.dataset.id, btn.dataset.value === 'true');
    } else if (action === 'edit-expense') {
      setState({ inlineEdit: { type: 'expense', id: btn.dataset.id } });
    } else if (action === 'remove-expense') {
      await api.deleteExpense(btn.dataset.id);
    } else if (action === 'view-receipt') {
      const url = await api.getReceiptSignedUrl(btn.dataset.path);
      window.open(url, '_blank', 'noopener');
    } else if (action === 'start-attribute-receipt') {
      setState({ attributingReceiptId: btn.dataset.id });
      runReceiptOcr(btn.dataset.id, btn.dataset.path);
    } else if (action === 'discard-pending-receipt') {
      await api.discardPendingReceipt(btn.dataset.id, btn.dataset.path);
    } else if (action === 'declare-settlement') {
      await api.declareSettlement(S.list.id, btn.dataset.from, btn.dataset.to, parseInt(btn.dataset.amount, 10));
    } else if (action === 'confirm-settlement') {
      await api.confirmSettlement(btn.dataset.id);
    } else if (action === 'remind-debtor') {
      const amount = formatCents(parseInt(btn.dataset.amount, 10));
      const subject = encodeURIComponent(`Petit rappel — ${S.list.name}`);
      const body = encodeURIComponent(`Salut ${btn.dataset.name},\n\nPetit rappel amical : sur la liste "${S.list.name}", il te reste ${amount} à rembourser.\n\nMerci !`);
      window.location.href = `mailto:${encodeURIComponent(btn.dataset.email)}?subject=${subject}&body=${body}`;
    } else if (action === 'add-friend') {
      const category = app.querySelector('#new-friend-category')?.value.trim();
      await api.addFriend(btn.dataset.id, category);
      await refreshFriends();
    } else if (action === 'add-friend-from-link') {
      await api.addFriend(btn.dataset.id, '');
      await loadFriends();
      setState({ friendsNotice: `${btn.dataset.name} a été ajouté·e à tes amis.` });
    } else if (action === 'remove-friend') {
      await api.removeFriend(btn.dataset.id);
      await refreshFriends();
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
      await refreshFriends();
    } else if (action === 'cancel-friend-invite') {
      await api.cancelFriendInvite(btn.dataset.id);
      await refreshFriends();
    } else if (action === 'add-member-from-search') {
      await api.addMemberByProfile(S.list.id, btn.dataset.id, btn.dataset.name);
      setState({ memberSearchResults: [] });
    } else if (action === 'accept-list-invite') {
      await api.acceptListInvite(btn.dataset.id);
      await loadHome();
    } else if (action === 'decline-list-invite') {
      await api.declineListInvite(btn.dataset.id);
      await loadHome();
    } else if (action === 'switch-list-tab') {
      history.replaceState(null, '', `#/list/${S.list.id}/${btn.dataset.tab}`);
      setState({ listTab: btn.dataset.tab });
    } else if (action === 'ask-delete-account') {
      setState({ confirmDeleteAccount: true });
    } else if (action === 'cancel-delete-account') {
      setState({ confirmDeleteAccount: false, error: '' });
    } else if (action === 'legal-back') {
      if (S.session) location.hash = '#/';
      else setState({ view: 'auth', authMode: 'login', error: '' });
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
    if (action === 'receipt-file-input') {
      handleReceiptFileOcr(el);
    } else if (action === 'reassign-expense-payer') {
      await api.reassignExpensePayer(el.dataset.id, el.value);
    } else if (action === 'update-friend-category') {
      await api.updateFriendCategory(el.dataset.id, el.value);
      await refreshFriends();
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
  'Password should be at least 8 characters': 'Le mot de passe doit contenir au moins 8 caractères.',
};

function friendlyError(err) {
  console.error(err);
  const msg = err?.message || '';
  return ERROR_TRANSLATIONS[msg] || msg || 'Une erreur est survenue.';
}

// Ferme le menu du profil au clic en dehors (le clic sur son propre bouton d'ouverture est
// géré directement par le handler ci-dessus, donc pas de conflit d'ordre).
document.addEventListener('click', (e) => {
  if (S.profileMenuOpen && !e.target.closest('.profile-menu-wrap')) {
    setState({ profileMenuOpen: false });
  }
});

boot();

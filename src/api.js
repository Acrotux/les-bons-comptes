import { supabase } from './supabase.js';

// ---------- Auth ----------

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthStateChange(cb) {
  return supabase.auth.onAuthStateChange((_event, session) => cb(session));
}

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin + import.meta.env.BASE_URL },
  });
  if (error) throw error;
  return data; // { user, session } — session est null si la confirmation email est exigée
}

export async function signInWithPassword(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function resetPassword(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + import.meta.env.BASE_URL,
  });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
}

// ---------- Profil ----------

export async function ensureProfile(user, displayName) {
  const { data: existing } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (existing) return existing;
  const name = displayName || (user.email ? user.email.split('@')[0] : 'Moi');
  const { data, error } = await supabase
    .from('profiles')
    .insert({ id: user.id, email: user.email, display_name: name })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateProfileName(userId, displayName) {
  const { error } = await supabase.from('profiles').update({ display_name: displayName }).eq('id', userId);
  if (error) throw error;
}

export async function uploadAvatar(userId, file) {
  const ext = file.name.split('.').pop();
  const path = `${userId}/avatar.${ext}`;
  const { error: uploadError } = await supabase.storage.from('avatars').upload(path, file, {
    upsert: true,
    contentType: file.type,
  });
  if (uploadError) throw uploadError;
  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  const avatarUrl = `${data.publicUrl}?t=${Date.now()}`;
  const { error: updateError } = await supabase.from('profiles').update({ avatar_url: avatarUrl }).eq('id', userId);
  if (updateError) throw updateError;
  return avatarUrl;
}

export async function updateEmail(newEmail) {
  const { error } = await supabase.auth.updateUser(
    { email: newEmail },
    { emailRedirectTo: window.location.origin + import.meta.env.BASE_URL }
  );
  if (error) throw error;
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export async function deleteAccount() {
  const { data, error } = await supabase.functions.invoke('delete-account');
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
}

// Rattache automatiquement les invitations (participants placeholder) faites à mon email.
export async function claimInvites(email) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase
    .from('list_members')
    .update({ profile_id: user.id })
    .is('profile_id', null)
    .eq('email', email);
  await supabase.rpc('claim_friend_invites');
}

// ---------- Amis ----------

export async function searchProfiles(query) {
  if (!query || query.trim().length < 2) return [];
  const { data, error } = await supabase.rpc('search_profiles', { query: query.trim() });
  if (error) throw error;
  return data;
}

export async function findProfileByEmail(email) {
  const { data, error } = await supabase.rpc('find_profile_by_email', { p_email: email.trim() });
  if (error) throw error;
  return data?.[0] || null;
}

// Carte publique minimale (pseudo + avatar) pour l'écran d'ajout via un lien d'invitation.
export async function getPublicProfileCard(profileId) {
  const { data, error } = await supabase.rpc('public_profile_card', { p_id: profileId });
  if (error) throw error;
  return data?.[0] || null;
}

export async function listFriends() {
  const { data, error } = await supabase.rpc('my_friends');
  if (error) throw error;
  return data;
}

export async function addFriend(friendId, category) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('friends')
    .upsert({ owner_id: user.id, friend_id: friendId, category: category || 'Général' }, { onConflict: 'owner_id,friend_id' });
  if (error) throw error;
}

export async function listPendingFriendInvites() {
  const { data, error } = await supabase.from('friend_invites').select('*').order('created_at');
  if (error) throw error;
  return data;
}

export async function inviteFriendByEmail(email, category) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('friend_invites')
    .upsert({ owner_id: user.id, email: email.trim().toLowerCase(), category: category || 'Général' }, { onConflict: 'owner_id,email' });
  if (error) throw error;
}

export async function cancelFriendInvite(inviteId) {
  const { error } = await supabase.from('friend_invites').delete().eq('id', inviteId);
  if (error) throw error;
}

export async function updateFriendCategory(friendRowId, category) {
  const { error } = await supabase.from('friends').update({ category }).eq('id', friendRowId);
  if (error) throw error;
}

export async function removeFriend(friendRowId) {
  const { error } = await supabase.from('friends').delete().eq('id', friendRowId);
  if (error) throw error;
}

// ---------- Listes ----------

export async function fetchMyLists() {
  const { data, error } = await supabase.from('lists').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function getList(listId) {
  const { data, error } = await supabase.from('lists').select('*').eq('id', listId).single();
  if (error) throw error;
  return data;
}

export async function createList(name, isPrivate, category, creatorDisplayName) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data: list, error } = await supabase
    .from('lists')
    .insert({ name, is_private: isPrivate, category: category || null, created_by: user.id })
    .select()
    .single();
  if (error) throw error;
  await supabase.from('list_members').insert({
    list_id: list.id,
    profile_id: user.id,
    display_name: creatorDisplayName,
    email: user.email,
    added_by: user.id,
  });
  return list;
}

export async function toggleListPrivacy(listId, isPrivate) {
  const { error } = await supabase.from('lists').update({ is_private: isPrivate }).eq('id', listId);
  if (error) throw error;
}

export async function toggleListStatus(listId, status) {
  const { error } = await supabase.from('lists').update({ status }).eq('id', listId);
  if (error) throw error;
}

export async function updateListCategory(listId, category) {
  const { error } = await supabase.from('lists').update({ category: category || null }).eq('id', listId);
  if (error) throw error;
}

export async function joinList(listId, displayName) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('list_members').insert({
    list_id: listId,
    profile_id: user.id,
    display_name: displayName,
    email: user.email,
    added_by: user.id,
  });
  if (error) throw error;
}

// ---------- Participants ----------

export async function getMembers(listId) {
  const { data, error } = await supabase.from('list_members').select('*').eq('list_id', listId).order('created_at');
  if (error) throw error;
  return data;
}

// Pseudo/avatar des participants déjà rattachés à un compte (pour affichage + couronne du créateur).
export async function getMemberProfiles(listId) {
  const { data, error } = await supabase.rpc('list_member_profiles', { p_list_id: listId });
  if (error) throw error;
  return data;
}

export async function addMember(listId, displayName, email) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('list_members').insert({
    list_id: listId,
    display_name: displayName,
    email: email || null,
    added_by: user.id,
  });
  if (error) throw error;
}

// Invite un utilisateur existant (trouvé par recherche de pseudo) — en attente jusqu'à ce
// qu'il accepte, pour ne pas l'exposer aux autres participants sans son accord.
export async function addMemberByProfile(listId, friendProfileId, displayName) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('list_members').insert({
    list_id: listId,
    profile_id: friendProfileId,
    display_name: displayName,
    added_by: user.id,
    status: 'invited',
  });
  if (error) throw error;
}

export async function getPendingListInvites() {
  const { data, error } = await supabase.rpc('my_pending_list_invites');
  if (error) throw error;
  return data;
}

export async function acceptListInvite(memberId) {
  const { error } = await supabase.from('list_members').update({ status: 'active' }).eq('id', memberId);
  if (error) throw error;
}

export async function declineListInvite(memberId) {
  const { error } = await supabase.from('list_members').delete().eq('id', memberId);
  if (error) throw error;
}

export async function updateMember(memberId, displayName, email) {
  const { error } = await supabase
    .from('list_members')
    .update({ display_name: displayName, email: email || null })
    .eq('id', memberId);
  if (error) throw error;
}

export async function deleteMember(memberId) {
  const { error } = await supabase.from('list_members').delete().eq('id', memberId);
  if (error) throw error;
}

export async function setCoAdmin(memberId, isCoAdmin) {
  const { error } = await supabase.from('list_members').update({ is_co_admin: isCoAdmin }).eq('id', memberId);
  if (error) throw error;
}

// ---------- Dépenses ----------

export async function getExpenses(listId) {
  const { data, error } = await supabase.from('expenses').select('*').eq('list_id', listId).order('created_at');
  if (error) throw error;
  return data;
}

// À plat : { expense_id, member_id, amount_cents } pour toutes les dépenses de la liste —
// une dépense peut avoir plusieurs payeurs à des montants différents.
export async function getExpensePayers(listId) {
  const { data, error } = await supabase.rpc('list_expense_payers', { p_list_id: listId });
  if (error) throw error;
  return data;
}

// `payers` : [{ member_id, amount_cents }, ...] (un seul élément dans le cas simple).
export async function addExpense(listId, label, payers, receiptFile) {
  const { data: { user } } = await supabase.auth.getUser();
  const totalCents = payers.reduce((sum, p) => sum + p.amount_cents, 0);
  const { data: expense, error } = await supabase
    .from('expenses')
    .insert({ list_id: listId, label, amount_cents: totalCents, added_by: user.id })
    .select()
    .single();
  if (error) throw error;

  const { error: payersError } = await supabase
    .from('expense_payers')
    .insert(payers.map((p) => ({ expense_id: expense.id, member_id: p.member_id, amount_cents: p.amount_cents })));
  if (payersError) throw payersError;

  if (receiptFile) {
    const path = await uploadReceipt(listId, expense.id, receiptFile);
    await supabase.from('expenses').update({ receipt_url: path }).eq('id', expense.id);
  }
  return expense;
}

// Cas simple (un seul payeur) : change qui a payé, sans toucher au reste de la dépense.
export async function reassignExpensePayer(expensePayerRowId, newMemberId) {
  const { error } = await supabase.from('expense_payers').update({ member_id: newMemberId }).eq('id', expensePayerRowId);
  if (error) throw error;
}

// Modifie le libellé, la répartition des payeurs et/ou le justificatif d'une dépense déjà
// enregistrée. `payerRowIdsToRemove` : ids des lignes expense_payers à supprimer (payeurs
// retirés). On upsert d'abord les nouveaux payeurs puis on supprime les anciens, dans cet
// ordre, pour ne jamais laisser le total de la dépense passer à zéro entre les deux étapes
// (la contrainte "amount_cents > 0" rejetterait sinon la suppression du dernier payeur).
export async function updateExpense(expenseId, listId, label, payers, payerRowIdsToRemove, receiptFile, removeReceipt) {
  const updates = { label };
  if (removeReceipt) updates.receipt_url = null;
  const { error: labelError } = await supabase.from('expenses').update(updates).eq('id', expenseId);
  if (labelError) throw labelError;

  const { error: upsertError } = await supabase
    .from('expense_payers')
    .upsert(
      payers.map((p) => ({ expense_id: expenseId, member_id: p.member_id, amount_cents: p.amount_cents })),
      { onConflict: 'expense_id,member_id' }
    );
  if (upsertError) throw upsertError;

  if (payerRowIdsToRemove.length) {
    const { error: delError } = await supabase.from('expense_payers').delete().in('id', payerRowIdsToRemove);
    if (delError) throw delError;
  }

  if (receiptFile) {
    const path = await uploadReceipt(listId, expenseId, receiptFile);
    const { error: receiptError } = await supabase.from('expenses').update({ receipt_url: path }).eq('id', expenseId);
    if (receiptError) throw receiptError;
  }
}

export async function deleteExpense(expenseId) {
  const { error } = await supabase.from('expenses').delete().eq('id', expenseId);
  if (error) throw error;
}

// ---------- Justificatifs (ticket de caisse / facture) ----------
// Bucket privé : on stocke le chemin, et on génère une URL signée à la demande pour l'affichage.

export async function uploadReceipt(listId, expenseId, file) {
  const ext = file.name.split('.').pop();
  const path = `${listId}/${expenseId}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('receipts').upload(path, file, { contentType: file.type });
  if (error) throw error;
  return path;
}

export async function getReceiptSignedUrl(path) {
  const { data, error } = await supabase.storage.from('receipts').createSignedUrl(path, 120);
  if (error) throw error;
  return data.signedUrl;
}

// ---------- Remboursements ----------

export async function getSettlements(listId) {
  const { data, error } = await supabase.from('settlements').select('*').eq('list_id', listId).order('declared_at');
  if (error) throw error;
  return data;
}

export async function declareSettlement(listId, fromMemberId, toMemberId, amountCents) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('settlements').insert({
    list_id: listId,
    from_member_id: fromMemberId,
    to_member_id: toMemberId,
    amount_cents: amountCents,
    declared_by: user.id,
  });
  if (error) throw error;
}

export async function confirmSettlement(settlementId) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('settlements')
    .update({ confirmed_by: user.id, confirmed_at: new Date().toISOString() })
    .eq('id', settlementId);
  if (error) throw error;
}

// ---------- Temps réel ----------

export function subscribeToList(listId, onChange) {
  const channel = supabase
    .channel(`list-${listId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'list_members', filter: `list_id=eq.${listId}` }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: `list_id=eq.${listId}` }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'expense_payers' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'settlements', filter: `list_id=eq.${listId}` }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lists', filter: `id=eq.${listId}` }, onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

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
  const { data, error } = await supabase.auth.signUp({ email, password });
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

// Rattache automatiquement les invitations (participants placeholder) faites à mon email.
export async function claimInvites(email) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase
    .from('list_members')
    .update({ profile_id: user.id })
    .is('profile_id', null)
    .eq('email', email);
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

export async function createList(name, isPrivate, creatorDisplayName) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data: list, error } = await supabase
    .from('lists')
    .insert({ name, is_private: isPrivate, created_by: user.id })
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

// ---------- Dépenses ----------

export async function getExpenses(listId) {
  const { data, error } = await supabase.from('expenses').select('*').eq('list_id', listId).order('created_at');
  if (error) throw error;
  return data;
}

export async function addExpense(listId, memberId, label, amountCents) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('expenses').insert({
    list_id: listId,
    member_id: memberId,
    label,
    amount_cents: amountCents,
    added_by: user.id,
  });
  if (error) throw error;
}

export async function reassignExpense(expenseId, newMemberId) {
  const { error } = await supabase.from('expenses').update({ member_id: newMemberId }).eq('id', expenseId);
  if (error) throw error;
}

export async function deleteExpense(expenseId) {
  const { error } = await supabase.from('expenses').delete().eq('id', expenseId);
  if (error) throw error;
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'settlements', filter: `list_id=eq.${listId}` }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lists', filter: `id=eq.${listId}` }, onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

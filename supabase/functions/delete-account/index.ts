// Suppression de compte (droit à l'effacement RGPD), en respectant l'intégrité des
// listes partagées : plutôt qu'une suppression brute (impossible sans casser l'historique
// des dépenses d'autres participants, à cause des références en base), ce compte est
// anonymisé et définitivement bloqué :
//  - profil (pseudo, photo) remplacé par "Compte supprimé"
//  - amis et invitations personnelles supprimés
//  - compte banni + email et mot de passe invalidés (connexion impossible)
// Les dépenses/remboursements déjà enregistrés restent visibles aux autres participants,
// mais sans identité personnelle attachée.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Non authentifié.' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) return json({ error: 'Non authentifié.' }, 401);

    const admin = createClient(supabaseUrl, serviceKey);

    // Anonymise le profil public (visible par les co-participants des listes partagées).
    await admin.from('profiles').update({ display_name: 'Compte supprimé', avatar_url: null }).eq('id', user.id);
    await admin.from('list_members').update({ display_name: 'Compte supprimé', email: null }).eq('profile_id', user.id);

    // Supprime les données strictement personnelles (n'affectent personne d'autre).
    await admin.from('friends').delete().eq('owner_id', user.id);
    await admin.from('friend_invites').delete().eq('owner_id', user.id);
    await admin.storage.from('avatars').remove([`${user.id}/avatar.png`, `${user.id}/avatar.jpg`, `${user.id}/avatar.jpeg`, `${user.id}/avatar.webp`, `${user.id}/avatar.gif`]);

    // Bloque définitivement le compte : email et mot de passe invalidés, connexion bannie.
    const { error: banErr } = await admin.auth.admin.updateUserById(user.id, {
      email: `deleted-${user.id}@deleted.invalid`,
      password: crypto.randomUUID() + crypto.randomUUID(),
      ban_duration: '876000h', // ~100 ans
    });
    if (banErr) return json({ error: banErr.message }, 500);

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Erreur inconnue.' }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

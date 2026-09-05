// Calcul des soldes et des remboursements suggérés.
// Toutes les sommes sont en centimes (entiers) pour éviter les erreurs d'arrondi.

export function computeBalances(members, expenses, settlements) {
  const memberIds = members.map((m) => m.id);
  const n = memberIds.length;
  const total = expenses.reduce((sum, e) => sum + e.amount_cents, 0);

  // Répartition équitable par méthode du plus grand reste.
  const shares = {};
  if (n > 0) {
    const base = Math.floor(total / n);
    const remainder = total - base * n;
    memberIds.forEach((id, i) => {
      shares[id] = base + (i < remainder ? 1 : 0);
    });
  }

  const paid = {};
  memberIds.forEach((id) => (paid[id] = 0));
  for (const e of expenses) {
    paid[e.member_id] = (paid[e.member_id] || 0) + e.amount_cents;
  }

  const balances = {};
  memberIds.forEach((id) => {
    balances[id] = (paid[id] || 0) - (shares[id] || 0);
  });

  for (const s of settlements) {
    if (!s.confirmed_at) continue;
    balances[s.from_member_id] = (balances[s.from_member_id] || 0) + s.amount_cents;
    balances[s.to_member_id] = (balances[s.to_member_id] || 0) - s.amount_cents;
  }

  return { total, shares, paid, balances, memberIds };
}

export function computeTransactions(balances, memberIds) {
  const debtors = [];
  const creditors = [];
  for (const id of memberIds) {
    const b = balances[id] || 0;
    if (b < 0) debtors.push({ id, amount: -b });
    else if (b > 0) creditors.push({ id, amount: b });
  }
  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const transactions = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const amount = Math.min(d.amount, c.amount);
    if (amount > 0) {
      transactions.push({ from: d.id, to: c.id, amount });
    }
    d.amount -= amount;
    c.amount -= amount;
    if (d.amount === 0) i++;
    if (c.amount === 0) j++;
  }
  return transactions;
}

export function formatCents(cents) {
  return (cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

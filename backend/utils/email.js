function normalizeEmailAddress(value = '') {
  return String(value || '').trim().toLowerCase();
}

function getEmailLookupCandidates(value = '') {
  const normalizedEmail = normalizeEmailAddress(value);
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return normalizedEmail ? [normalizedEmail] : [];
  }

  const [localPart, domainPart] = normalizedEmail.split('@');
  const candidates = new Set([normalizedEmail]);

  if (domainPart === 'gmail.com' || domainPart === 'googlemail.com') {
    const localWithoutDots = localPart.replace(/\./g, '');
    candidates.add(`${localWithoutDots}@gmail.com`);
    candidates.add(`${localWithoutDots}@googlemail.com`);
    candidates.add(`${localPart}@gmail.com`);
    candidates.add(`${localPart}@googlemail.com`);
  }

  return Array.from(candidates);
}

function buildEmailLookupFilter(value = '') {
  const candidates = getEmailLookupCandidates(value);
  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return { email: candidates[0] };
  }

  return { email: { $in: candidates } };
}

module.exports = {
  normalizeEmailAddress,
  getEmailLookupCandidates,
  buildEmailLookupFilter,
};

/* Service « user » en mode local : identité propre à ce navigateur.
 * Remplace claude.use("user"). À remplacer par l'authentification réelle
 * (SSO Microsoft / Google, Supabase Auth, etc.) lors de la mise en production.
 * Contrat utilisé par l'application : id(), profiles(ids). */
Platform.register("local", "user", async (config) => {
  const KEY_ID = "hh-user-id", KEY_NAMES = "hh-user-names";
  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  let id = read(KEY_ID, null);
  if (!id) { id = "local-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); write(KEY_ID, id); }
  const name = (config.user && config.user.name) || "Utilisateur local";
  const names = read(KEY_NAMES, {});
  if (names[id] !== name) { names[id] = name; write(KEY_NAMES, names); }

  return {
    async id() { return id; },
    async me() { return { id, name }; },
    /** { [id]: { id, name } } — name vaut "" si l'utilisateur est inconnu. */
    async profiles(ids) {
      const known = read(KEY_NAMES, {});
      return Object.fromEntries((ids || []).map((x) => [x, { id: x, name: known[x] || "" }]));
    },
    isOwner() { return true; },
    canEdit() { return true; },
    can() { return true; },
  };
});

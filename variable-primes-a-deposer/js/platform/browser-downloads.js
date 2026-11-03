/* Service « downloads » : téléchargement direct par le navigateur.
 * Remplace claude.use("downloads"). Valable quel que soit le backend.
 * Contrat : save({ filename, data }) -> Promise<{ status: "saved" }>. */
Platform.register("*", "downloads", async () => ({
  async save({ filename, data, type } = {}) {
    if (!filename) throw Platform.error("bad_request", "Nom de fichier manquant.");
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || guessType(filename) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { status: "saved" };
  },
}));

function guessType(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  return { csv: "text/csv;charset=utf-8", json: "application/json", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", txt: "text/plain;charset=utf-8" }[ext] || "application/octet-stream";
}

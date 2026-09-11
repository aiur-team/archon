startSharePanel();

function startSharePanel() {
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  document.addEventListener("session", mountSharePanel, { once: true });
}

function mountSharePanel(event) {
  const session = event.detail;
  if (!validSession(session)) return;

  const host = document.querySelector(".head-top");
  if (!(host instanceof HTMLElement)
    || host.ownerDocument !== document
    || !host.isConnected) return;
  for (const child of host.children) {
    if (child.id === "doc-share-button" || child.classList.contains("share-btn")) return;
  }

  let docId = session.doc;
  let sessionRole = session.role;
  let mayShare = session.canShare;
  let maySeeMembers = session.canSeeMembers;
  let isShared = session.shared;
  let panel = null;
  let heading = null;
  let closeButton = null;
  let status = null;
  let defaultPolicy = null;
  let memberSection = null;
  let memberList = null;
  let invitationSection = null;
  let invitationList = null;
  let invoker = null;
  let controller = null;
  let generation = 0;
  let positionFrame = 0;
  let removed = false;

  /* P4-L write state. Owner authority lives only in these closure fields: it
     is never read back from the DOM, an attribute, or the cached session
     event once a transfer or a write-time 403 has put it in doubt. */
  let inviteForm = null;
  let inviteEmail = null;
  let inviteRole = null;
  let confirmation = null;
  let lastDomains = null;
  /* ACN-009's domain editor. `domainEntry` is the owner's own typed value,
     held here rather than read back off the input, so a roster refresh that
     rebuilds the section does not throw away a domain they are mid-way through
     correcting after a refusal. */
  let domainSection = null;
  let domainList = null;
  let domainInput = null;
  let domainEntry = "";
  let mutationMessage = "";
  let busy = false;
  let authorityUnknown = false;
  let authorityAtRisk = false;
  let pendingHeadingFocus = false;
  let latched = null;

  const button = document.createElement("button");
  button.id = "doc-share-button";
  button.className = "tt share-btn";
  button.setAttribute("type", "button");
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "doc-share-panel");
  button.appendChild(document.createTextNode("Share"));
  button.addEventListener("click", togglePanel);
  host.appendChild(button);

  function validSession(value) {
    if (!isRecord(value)
      || typeof value.doc !== "string"
      || !/^[0-9a-f]{6}$/.test(value.doc)) return false;
    if (value.shared !== true || value.canSeeMembers !== true) return false;
    return (value.role === "owner" && value.canShare === true)
      || (value.role === "editor" && value.canShare === false);
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function fixedElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className !== "") element.className = className;
    if (text !== null) element.appendChild(document.createTextNode(text));
    return element;
  }

  function createPanel() {
    panel = fixedElement("aside", "share-pop", null);
    panel.id = "doc-share-panel";
    panel.hidden = true;
    panel.setAttribute("aria-labelledby", "doc-share-title");

    const panelHeader = fixedElement("header", "share-head", null);
    heading = fixedElement("h2", "", "Access");
    heading.id = "doc-share-title";
    heading.setAttribute("tabindex", "-1");
    closeButton = fixedElement("button", "share-close", "Close access panel");
    closeButton.setAttribute("type", "button");
    panelHeader.append(heading, closeButton);

    status = fixedElement("p", "share-status", null);
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    defaultPolicy = fixedElement("p", "share-default", null);

    memberSection = fixedElement("section", "share-members", null);
    memberSection.setAttribute("aria-labelledby", "doc-share-members-title");
    const memberTitle = fixedElement("h3", "", "People with access");
    memberTitle.id = "doc-share-members-title";
    memberList = fixedElement("ul", "share-list", null);
    memberSection.append(memberTitle, memberList);

    invitationSection = fixedElement("section", "share-invitations", null);
    invitationSection.setAttribute("aria-labelledby", "doc-share-invitations-title");
    const invitationTitle = fixedElement("h3", "", "Pending invitations");
    invitationTitle.id = "doc-share-invitations-title";
    invitationList = fixedElement("ul", "share-list", null);
    invitationSection.append(invitationTitle, invitationList);

    panel.append(panelHeader, status, defaultPolicy, memberSection, invitationSection);
    document.body.appendChild(panel);
    closeButton.addEventListener("click", closePanel);
    document.addEventListener("keydown", handleKeydown);
    document.addEventListener("pointerdown", handlePointerdown);
    window.addEventListener("resize", handlePositionChange);
    window.addEventListener("scroll", handlePositionChange, true);
  }

  function togglePanel() {
    if (removed) return;
    if (panel === null) createPanel();
    if (!panel.hidden) {
      closePanel();
      return;
    }
    openPanel();
  }

  function openPanel() {
    invoker = button;
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    mutationMessage = "";
    status.textContent = "Loading access…";
    if (!positionPanel()) return;
    heading.focus();
    if (authorityUnknown) reconcileThenRefresh();
    else refreshRoster();
  }

  function closePanel() {
    if (panel === null || panel.hidden) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    generation += 1;
    busy = false;
    pendingHeadingFocus = false;
    mutationMessage = "";
    latched = null;
    panel.removeAttribute("aria-busy");
    clearConfirmation(false);
    if (inviteEmail !== null) inviteEmail.value = "";
    /* Closing during a transfer or a session reconciliation leaves ownership
       genuinely unknown; the next open must ask the server, not the cache. */
    if (authorityAtRisk) {
      authorityAtRisk = false;
      demoteAuthority();
    }
    if (controller !== null) {
      const closingController = controller;
      controller = null;
      closingController.abort();
    }
    if (positionFrame !== 0) {
      cancelAnimationFrame(positionFrame);
      positionFrame = 0;
    }
    if (invoker !== null && invoker.isConnected) invoker.focus();
  }

  function handleKeydown(event) {
    if (panel !== null && !panel.hidden && event.key === "Escape") {
      event.preventDefault();
      closePanel();
    }
  }

  function handlePointerdown(event) {
    if (panel === null || panel.hidden || event.button !== 0) return;
    if (!panel.contains(event.target) && !button.contains(event.target)) closePanel();
  }

  function handlePositionChange() {
    if (panel === null || panel.hidden || positionFrame !== 0) return;
    positionFrame = -1;
    const requestedFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      positionPanel();
    });
    if (positionFrame === -1) positionFrame = requestedFrame;
  }

  function positionPanel() {
    const rect = button.getBoundingClientRect();
    const values = [
      window.scrollX, window.scrollY, window.innerHeight,
      panel.offsetWidth, panel.offsetHeight,
      rect.height,
      rect.top, rect.bottom, rect.right,
      document.documentElement.clientWidth,
    ];
    if (!values.every(Number.isFinite)) {
      closePanel();
      return false;
    }

    /* Bound the height to the room beside the toggle before anything is placed.
       Since ACN-009 the panel can be taller than either gap, and the fallback
       below -- clamp between `lowerTop` and `upperTop` -- then lands it across
       the toggle, where it intercepts every click on the one control that
       closes it. Picking the larger gap and capping the panel to it removes the
       overlap rather than narrowing it: the panel scrolls, which it is already
       styled to do. `offsetHeight` is re-read afterwards because the cap may
       have shrunk it. */
    const gapBelow = window.innerHeight - rect.bottom - 16;
    const gapAbove = rect.top - 16;
    /* Floored, and the floor is the honest edge of this rule: it takes a toggle
       spanning the whole viewport for both gaps to fall under it, and a panel
       bounded to nothing at all would hide the close button rather than merely
       sit under it. Below the floor the behaviour is what it was before. */
    const room = Math.max(160, Math.round(Math.max(gapBelow, gapAbove)));
    panel.style.maxHeight = `${room}px`;

    const height = panel.offsetHeight;
    const lowerTop = window.scrollY + 8;
    const upperTop = window.scrollY + window.innerHeight - height - 8;
    const below = window.scrollY + rect.bottom + 8;
    const above = window.scrollY + rect.top - height - 8;
    let top;
    if (upperTop < lowerTop) top = lowerTop;
    else if (below <= upperTop) top = below;
    else top = Math.min(upperTop, Math.max(lowerTop, above));

    const lowerLeft = window.scrollX + 8;
    const upperLeft = window.scrollX + document.documentElement.clientWidth
      - panel.offsetWidth - 8;
    const desiredLeft = window.scrollX + rect.right - panel.offsetWidth;
    const left = upperLeft < lowerLeft
      ? lowerLeft
      : Math.min(upperLeft, Math.max(lowerLeft, desiredLeft));
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
    return true;
  }

  async function refreshRoster() {
    const requestGeneration = generation + 1;
    generation = requestGeneration;
    const requestController = new AbortController();
    controller = requestController;
    const endpoint = new URL("/api/access", location.href);
    endpoint.searchParams.set("doc", docId);
    const deadline = setTimeout(() => requestController.abort(), 5_000);
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        mode: "same-origin",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: requestController.signal,
      });
      if (!isCurrent(requestGeneration)) return;
      if (response.status === 401 || response.status === 403) {
        removeFeature();
        return;
      }
      if (response.status !== 200) throw new Error();
      const contentType = response.headers.get("Content-Type");
      if (typeof contentType !== "string"
        || !/^[\t ]*(?:application\/json|application\/json; charset=utf-8)[\t ]*$/i.test(contentType)) {
        throw new Error();
      }
      const contentLength = response.headers.get("Content-Length");
      if (contentLength !== null) {
        if (!/^(?:0|[1-9][0-9]{0,4})$/.test(contentLength)) throw new Error();
        const length = Number(contentLength);
        if (!Number.isSafeInteger(length) || length > 65_536) throw new Error();
      }
      const responseBody = response.body;
      if (responseBody === null) throw new Error();
      const reader = responseBody.getReader();
      let complete = false;
      const chunks = [];
      let byteCount = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done === true) {
            complete = true;
            break;
          }
          if (!(result.value instanceof Uint8Array) || result.value.byteLength === 0) throw new Error();
          const nextCount = byteCount + result.value.byteLength;
          if (!Number.isSafeInteger(nextCount) || nextCount > 65_536) throw new Error();
          byteCount = nextCount;
          chunks.push(result.value);
        }
      } finally {
        if (!complete) {
          try {
            await reader.cancel();
          } catch (error) {
            // Cancellation is best-effort; the fixed refresh failure is retained.
          }
        }
        reader.releaseLock();
      }
      if (!isCurrent(requestGeneration)) return;
      const bytes = new Uint8Array(byteCount);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const roster = JSON.parse(decoded);
      if (!validRoster(roster)) throw new Error();
      if (!isCurrent(requestGeneration)) return;
      renderRoster(roster);
    } catch (error) {
      if (isCurrent(requestGeneration)) {
        /* A read failure outranks and replaces any retained mutation result. */
        mutationMessage = "";
        status.textContent = "Access list could not be refreshed.";
      }
    } finally {
      clearTimeout(deadline);
      if (generation === requestGeneration && controller === requestController) controller = null;
      settleReadUi(requestGeneration);
    }
  }

  /* The write controls are re-enabled only once the refresh that follows a
     mutation has settled, so a second write can never race the read that owns
     the authoritative state. */
  function settleReadUi(requestGeneration) {
    if (removed || panel === null || panel.hidden || generation !== requestGeneration) return;
    panel.removeAttribute("aria-busy");
    restoreControlsAfterWrite();
    if (pendingHeadingFocus) {
      pendingHeadingFocus = false;
      heading.focus();
    }
  }

  function isCurrent(requestGeneration) {
    return !removed && generation === requestGeneration && panel !== null && !panel.hidden;
  }

  function validRoster(value) {
    if (!exactRecord(value, ["doc", "allowedDomains", "members", "invitations"])) return false;
    if (value.doc !== docId || !validDomainList(value.allowedDomains)) return false;
    if (!Array.isArray(value.members) || value.members.length < 1 || value.members.length > 51) return false;
    if (!Array.isArray(value.invitations) || value.invitations.length > 50) return false;
    if ((value.members.length - 1) + value.invitations.length > 50) return false;

    const subjects = new Set();
    const memberEmails = new Set();
    let previousMember = null;
    for (let index = 0; index < value.members.length; index += 1) {
      const member = value.members[index];
      if (!exactRecord(member, ["sub", "email", "name", "role"])) return false;
      if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(member.sub)) return false;
      if (!validEmail(member.email) || typeof member.name !== "string" || member.name.length > 200) return false;
      if (subjects.has(member.sub) || memberEmails.has(member.email)) return false;
      subjects.add(member.sub);
      memberEmails.add(member.email);
      if (index === 0) {
        if (member.role !== "owner" || member.name !== "") return false;
      } else {
        if (!["editor", "commenter", "viewer"].includes(member.role)) return false;
        if (previousMember !== null
          && (member.email < previousMember.email
            || (member.email === previousMember.email && member.sub <= previousMember.sub))) return false;
        previousMember = member;
      }
    }

    const invitationEmails = new Set();
    let previousEmail = null;
    for (const invitation of value.invitations) {
      if (!exactRecord(invitation, ["email", "role", "expiresAt"])) return false;
      if (!validEmail(invitation.email)
        || !["editor", "commenter", "viewer"].includes(invitation.role)
        || typeof invitation.expiresAt !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(invitation.expiresAt)) return false;
      if (invitationEmails.has(invitation.email)
        || (previousEmail !== null && invitation.email <= previousEmail)) return false;
      const expires = new Date(invitation.expiresAt);
      if (!Number.isFinite(expires.getTime()) || expires.toISOString() !== invitation.expiresAt) return false;
      invitationEmails.add(invitation.email);
      previousEmail = invitation.email;
    }
    return true;
  }

  function exactRecord(value, keys) {
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
  }

  function validEmail(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 254) return false;
    if (value !== value.toLowerCase() || /[\x00-\x20\x7f,/:\\]/.test(value)) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) > 127) return false;
    }
    const at = value.indexOf("@");
    return at > 0 && at === value.lastIndexOf("@") && at < value.length - 1;
  }

  /**
   * The document's domain list, as the roster reports it (ACN-008).
   *
   * The server stores a normalized, sorted, de-duplicated list of at most twenty
   * entries, so anything else is a roster this panel did not ask for and will
   * not render. This is a shape check on a response, never an access decision:
   * the only authority on who may read the document is `resolveRole()`, and this
   * runs in a browser the reader controls.
   */
  function validDomainList(value) {
    if (!Array.isArray(value) || value.length > 20) return false;
    let previous = null;
    for (const entry of value) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 253) return false;
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(entry)) return false;
      if (previous !== null && entry <= previous) return false;
      previous = entry;
    }
    return true;
  }

  function roleLabel(role) {
    return role.charAt(0).toUpperCase() + role.slice(1);
  }

  function appendIsolatedFields(row, fields) {
    fields.forEach((field, index) => {
      if (index !== 0) row.appendChild(document.createTextNode(" — "));
      row.appendChild(fixedElement("bdi", "share-value", field));
    });
  }

  function renderRoster(roster) {
    clearConfirmation(false);
    const owner = ownerEligible();
    const memberRows = roster.members.map((member, index) => {
      const row = document.createElement("li");
      const fields = member.name === ""
        ? [member.email, roleLabel(member.role)]
        : [member.name, member.email, roleLabel(member.role)];
      appendIsolatedFields(row, fields);
      if (owner && index !== 0) row.appendChild(memberControls(member, row));
      return row;
    });
    const invitationRows = roster.invitations.map((invitation) => {
      const row = document.createElement("li");
      appendIsolatedFields(row, [invitation.email, roleLabel(invitation.role)]);
      row.appendChild(document.createTextNode(" — Pending until "));
      const date = document.createElement("time");
      date.setAttribute("datetime", invitation.expiresAt);
      date.appendChild(document.createTextNode(invitation.expiresAt.slice(0, 10)));
      row.appendChild(date);
      if (owner) row.appendChild(invitationControls(invitation));
      return row;
    });
    memberList.replaceChildren(...memberRows);
    invitationList.replaceChildren(...invitationRows);
    renderOwnerForms(roster.allowedDomains, owner);
    invitationSection.hidden = invitationRows.length === 0;
    status.textContent = mutationMessage;
    latched = null;
    handlePositionChange();
  }

  function removeFeature() {
    if (removed) return;
    removed = true;
    generation += 1;
    if (positionFrame !== 0) {
      cancelAnimationFrame(positionFrame);
      positionFrame = 0;
    }
    if (invoker !== null && invoker.isConnected) invoker.focus();
    button.removeEventListener("click", togglePanel);
    if (closeButton !== null) closeButton.removeEventListener("click", closePanel);
    document.removeEventListener("keydown", handleKeydown);
    document.removeEventListener("pointerdown", handlePointerdown);
    window.removeEventListener("resize", handlePositionChange);
    window.removeEventListener("scroll", handlePositionChange, true);
    if (memberList !== null) memberList.replaceChildren();
    if (invitationList !== null) invitationList.replaceChildren();
    if (defaultPolicy !== null) defaultPolicy.textContent = "";
    confirmation = null;
    inviteForm = null;
    inviteEmail = null;
    inviteRole = null;
    lastDomains = null;
    domainEntry = "";
    mutationMessage = "";
    busy = false;
    pendingHeadingFocus = false;
    authorityAtRisk = false;
    latched = null;
    button.remove();
    if (panel !== null) panel.remove();
    if (controller !== null) {
      const removingController = controller;
      controller = null;
      removingController.abort();
    }
    docId = "";
    sessionRole = "";
    mayShare = false;
    maySeeMembers = false;
    isShared = false;
    invoker = null;
  }

  /* ------------------------------------------------------------------ *
   * P4-L — owner-only controls and the single serialized write path.
   * ------------------------------------------------------------------ */

  /* Owner controls exist only while the latest validated session — the initial
     event or a reconciliation — still says owner. `authorityUnknown` is the
     one-way door a transfer or a write-time 403 opens: it can only be closed
     by a fresh server session, never by the cached event. */
  function ownerEligible() {
    return !removed
      && !authorityUnknown
      && sessionRole === "owner"
      && mayShare === true
      && maySeeMembers === true
      && isShared === true;
  }

  function demoteAuthority() {
    sessionRole = "editor";
    mayShare = false;
    authorityUnknown = true;
    clearConfirmation(false);
    removeOwnerControls();
  }

  function opControl(element) {
    element.classList.add("share-op");
    return element;
  }

  function opButton(className, text) {
    const control = fixedElement("button", className, text);
    control.setAttribute("type", "button");
    return opControl(control);
  }

  function roleSelect(className, roles, selected) {
    const select = fixedElement("select", className, null);
    for (const role of roles) {
      const option = fixedElement("option", "", roleLabel(role));
      option.value = role;
      select.appendChild(option);
    }
    select.value = selected;
    return opControl(select);
  }

  /* The accessible name is label text, so a server address never reaches an
     attribute, an id, a selector or a live announcement. */
  function labelled(text, control) {
    const label = fixedElement("label", "share-op-label", text);
    label.appendChild(control);
    return label;
  }

  /* A write disables every owner control and remembers which ones were
     already disabled — an unchanged select's Save button, or the row behind an
     open confirmation — so a failed refresh restores the panel it interrupted
     rather than enabling a button the roster never justified. */
  function disableControlsForWrite() {
    if (panel === null) return;
    latched = new Set();
    for (const node of panel.querySelectorAll(".share-op")) {
      if (node.disabled) latched.add(node);
      node.disabled = true;
    }
  }

  function restoreControlsAfterWrite() {
    if (panel === null || latched === null) return;
    const held = latched;
    latched = null;
    for (const node of panel.querySelectorAll(".share-op")) node.disabled = held.has(node);
    if (confirmation !== null && confirmation.controls !== null) {
      for (const node of confirmation.controls.querySelectorAll(".share-op")) node.disabled = true;
    }
  }

  function removeOwnerControls() {
    clearConfirmation(false);
    removeDomainSection();
    if (inviteForm !== null) {
      inviteForm.remove();
      inviteForm = null;
      inviteEmail = null;
      inviteRole = null;
    }
    if (panel !== null) {
      for (const group of panel.querySelectorAll(".share-row-controls")) group.remove();
    }
    if (defaultPolicy !== null && lastDomains !== null) {
      renderDomainPolicy(lastDomains);
    }
  }

  /**
   * The organisation-default control used to sit here, and ACN-008 removed the
   * tier it wrote. What replaces it, in ACN-009, is an editor for the thing
   * that decides instead: the document's own domain list.
   *
   * Two surfaces, and the split is the point. `renderDomainPolicy` writes one
   * read-only sentence for everybody who can see the roster, owner or editor,
   * because "who can read this" is a fact about the document rather than an
   * owner's secret. The editable section below it is built only for an owner
   * and is *removed* rather than disabled for anybody else -- an editor gets no
   * add control, no remove control and no form in the DOM at all, so there is
   * nothing for a devtools toggle to re-enable. The server refuses their write
   * regardless, which is the half that decides.
   */
  function renderOwnerForms(allowedDomains, owner) {
    lastDomains = allowedDomains;
    removeDomainSection();
    if (inviteForm !== null) {
      inviteForm.remove();
      inviteForm = null;
      inviteEmail = null;
      inviteRole = null;
    }
    renderDomainPolicy(allowedDomains);
    if (!owner) return;
    inviteForm = createInviteForm();
    panel.insertBefore(inviteForm, memberSection);
    domainSection = createDomainSection(allowedDomains);
    panel.appendChild(domainSection);
  }

  function removeDomainSection() {
    if (domainSection === null) return;
    domainSection.remove();
    domainSection = null;
    domainList = null;
    domainInput = null;
  }

  /**
   * The third section, beside people and invitations.
   *
   * It lists domains rather than people, and offers no per-person control for
   * anybody a domain admits, because a domain grant stores no record of who
   * used it -- there is no person here to remove. Removing the domain is the
   * only thing this list can offer and the only thing it does.
   */
  function createDomainSection(allowedDomains) {
    const section = fixedElement("section", "share-domains", null);
    section.setAttribute("aria-labelledby", "doc-share-domains-title");
    const title = fixedElement("h3", "", "Email domains");
    title.id = "doc-share-domains-title";
    domainList = fixedElement("ul", "share-list", null);
    domainList.replaceChildren(...allowedDomains.map(domainRow));

    const form = fixedElement("form", "share-domain-add", null);
    form.setAttribute("novalidate", "");
    domainInput = opControl(fixedElement("input", "share-domain-input", null));
    domainInput.setAttribute("type", "text");
    domainInput.setAttribute("autocomplete", "off");
    domainInput.setAttribute("autocapitalize", "none");
    domainInput.setAttribute("spellcheck", "false");
    domainInput.setAttribute("maxlength", "253");
    domainInput.value = domainEntry;
    domainInput.addEventListener("input", () => {
      domainEntry = domainInput.value;
    });
    const submit = opControl(fixedElement("button", "share-domain-submit", "Add domain"));
    submit.setAttribute("type", "submit");
    form.append(labelled("Domain", domainInput), submit);
    form.addEventListener("submit", handleAddDomain);

    section.append(title, domainList, form);
    return section;
  }

  function domainRow(domain) {
    const row = document.createElement("li");
    appendIsolatedFields(row, [domain]);
    /* Deliberately not `.share-row-controls`. That class is the member and
       invitation row group, and `removeOwnerControls` strips every one of them
       by selector; a domain row wearing it would be half-dismantled there while
       its section stayed on the page. `removeDomainSection` owns this one. */
    const group = fixedElement("div", "share-domain-controls", null);
    const remove = opButton("share-remove-domain", "Remove");
    /* The domain rides in the control's accessible name as visually hidden
       *text*, never an attribute, an id or a selector -- the same rule the
       row's own value follows. Without it every row's button would be named
       "Remove" and a reader hearing the controls alone could not tell them
       apart. */
    const named = fixedElement("span", "share-visually-hidden", ` ${domain}`);
    remove.appendChild(named);
    remove.addEventListener("click", () => {
      if (lastDomains === null) return;
      writeDomains(lastDomains.filter((entry) => entry !== domain), false);
    });
    group.appendChild(remove);
    row.appendChild(group);
    return row;
  }

  /**
   * Add whatever is in the box.
   *
   * The value is trimmed and lowercased and otherwise sent exactly as typed.
   * This panel holds no copy of the public-mailbox denylist and pre-validates
   * against nothing: that list and its site-wide override are ACN-007's, and a
   * second copy here would be a policy that drifts and a refusal an owner could
   * not argue with. An empty box is the one thing refused locally, because
   * there is nothing to send.
   */
  function handleAddDomain(event) {
    event.preventDefault();
    if (!ownerEligible() || domainInput === null || lastDomains === null) return;
    if (busy || controller !== null) return;
    const entered = domainInput.value.trim().toLowerCase();
    if (entered === "") {
      mutationMessage = "Enter a domain to add.";
      status.textContent = mutationMessage;
      return;
    }
    if (lastDomains.includes(entered)) {
      domainEntry = "";
      domainInput.value = "";
      return;
    }
    writeDomains([...lastDomains, entered], true);
  }

  /**
   * Send the whole list, as ACN-008's `["doc", "allowedDomains"]` body variant.
   *
   * The list is replaced rather than added to or removed from, which is the
   * route's own shape: an owner looking at a list and pressing a control is
   * stating what the list is, and two owners doing that at once resolve to a
   * list one of them actually looked at rather than to a merge neither asked
   * for.
   *
   * This is the one write on this panel whose success is `200` rather than
   * `204`, because normalisation is visible -- case folds, duplicates collapse,
   * order becomes canonical -- and the route answers with what it stored. The
   * following roster read still owns every value the panel renders; the status
   * code is all this call takes from the response.
   */
  function writeDomains(allowedDomains, clearEntry) {
    sendMutation("PATCH", ACCESS_PATH, { doc: docId, allowedDomains }, false, () => {
      if (!clearEntry) return;
      domainEntry = "";
      if (domainInput !== null) domainInput.value = "";
    }, { okStatus: 200, reasonFor: domainRefusal });
  }

  /**
   * What an owner is told about a refused domain list.
   *
   * The code is a closed enumeration this file matches against a table of its
   * own literals; the response's text is never rendered. That keeps the panel's
   * rule -- no mutation body becomes visible copy -- while still telling an
   * owner which of the three refusals they hit, because the three call for
   * three different actions: argue with a policy, cut the list, or fix a typo.
   * Anything else, including `forbidden` and `not-found`, falls through to the
   * generic line rather than saying why.
   */
  function domainRefusal(code) {
    return Object.prototype.hasOwnProperty.call(DOMAIN_REFUSALS, code)
      ? DOMAIN_REFUSALS[code]
      : null;
  }

  function renderDomainPolicy(allowedDomains) {
    if (defaultPolicy === null) return;
    defaultPolicy.hidden = false;
    defaultPolicy.textContent = allowedDomains.length === 0
      ? "Only the people listed below can read this document."
      : `Anyone with a verified address at ${allowedDomains.join(", ")} can read this document.`;
  }

  function createInviteForm() {
    const form = fixedElement("form", "share-invite", null);
    form.setAttribute("novalidate", "");
    inviteEmail = opControl(fixedElement("input", "share-invite-email", null));
    inviteEmail.setAttribute("type", "email");
    inviteEmail.setAttribute("autocomplete", "off");
    inviteEmail.setAttribute("maxlength", "254");
    inviteRole = roleSelect("share-invite-role", ["commenter", "viewer", "editor"], "commenter");
    const submit = opControl(fixedElement("button", "share-invite-submit", "Invite"));
    submit.setAttribute("type", "submit");
    form.append(labelled("Email", inviteEmail), labelled("Role", inviteRole), submit);
    form.addEventListener("submit", handleInvite);
    return form;
  }

  function handleInvite(event) {
    event.preventDefault();
    if (!ownerEligible() || inviteEmail === null) return;
    if (busy || controller !== null) return;
    const email = inviteEmail.value.trim().toLowerCase();
    if (!validInviteEmail(email)) {
      mutationMessage = "Enter a valid email address.";
      status.textContent = mutationMessage;
      return;
    }
    const role = inviteRole.value;
    sendMutation("POST", ACCESS_PATH, { doc: docId, email, role }, false, () => {
      if (inviteEmail !== null) inviteEmail.value = "";
    });
  }

  /* The canonical P2-G grammar: 3–254 bytes, ASCII, one interior `@`. Accepted
     input is ASCII, so the `maxlength` character cap and the byte ceiling are
     the same number. */
  function validInviteEmail(value) {
    return typeof value === "string" && value.length >= 3 && validEmail(value);
  }

  function memberControls(member, row) {
    const target = { sub: member.sub, role: member.role, email: member.email };
    const group = fixedElement("div", "share-row-controls", null);
    const select = roleSelect("share-role", ["editor", "commenter", "viewer"], target.role);
    const save = opButton("share-save-role", "Save role");
    save.disabled = true;
    select.addEventListener("change", () => {
      save.disabled = select.value === target.role;
    });
    save.addEventListener("click", () => {
      if (select.value === target.role) return;
      sendMutation("PATCH", ACCESS_PATH, { doc: docId, sub: target.sub, role: select.value }, false, noop);
    });
    const revoke = opButton("share-revoke", "Revoke access");
    revoke.addEventListener("click", () => {
      sendMutation("DELETE", ACCESS_PATH, { doc: docId, sub: target.sub }, false, noop);
    });
    const transfer = opButton("share-transfer", "Transfer ownership");
    transfer.addEventListener("click", () => openConfirmation(row, group, transfer, target.sub));
    group.append(labelled(`Role for ${target.email}`, select), save, revoke, transfer);
    return group;
  }

  function invitationControls(invitation) {
    const target = { email: invitation.email, role: invitation.role };
    const group = fixedElement("div", "share-row-controls", null);
    const select = roleSelect("share-role", ["editor", "commenter", "viewer"], target.role);
    const save = opButton("share-save-role", "Save role");
    save.disabled = true;
    select.addEventListener("change", () => {
      save.disabled = select.value === target.role;
    });
    save.addEventListener("click", () => {
      if (select.value === target.role) return;
      sendMutation("PATCH", ACCESS_PATH, { doc: docId, email: target.email, role: select.value }, false, noop);
    });
    const cancel = opButton("share-cancel-invitation", "Cancel invitation");
    cancel.addEventListener("click", () => {
      sendMutation("DELETE", ACCESS_PATH, { doc: docId, email: target.email }, false, noop);
    });
    /* P4-J's recovery-only reissue branch: the identical invite body, which
       changes no access record or expiry and appends no event. */
    const resend = opButton("share-resend", "Resend setup link");
    resend.addEventListener("click", () => {
      sendMutation("POST", ACCESS_PATH, { doc: docId, email: target.email, role: target.role }, false, noop);
    });
    group.append(labelled(`Role for ${target.email}`, select), save, cancel, resend);
    return group;
  }

  function openConfirmation(row, controls, initiator, sub) {
    if (!ownerEligible() || busy) return;
    clearConfirmation(true);
    const group = fixedElement("div", "share-transfer-confirm", null);
    group.appendChild(fixedElement("p", "", TRANSFER_WARNING));
    const confirm = opButton("share-transfer-yes", "Transfer");
    const cancel = opButton("share-transfer-no", "Cancel");
    confirm.addEventListener("click", () => {
      sendMutation("POST", TRANSFER_PATH, { doc: docId, sub }, true, noop);
    });
    cancel.addEventListener("click", () => clearConfirmation(true));
    group.append(confirm, cancel);
    /* The row's own disabled state is remembered, not assumed: cancelling
       must not enable a Save button an unchanged select never justified. */
    const held = new Set();
    for (const node of controls.querySelectorAll(".share-op")) {
      if (node.disabled) held.add(node);
      node.disabled = true;
    }
    confirmation = { group, initiator, controls, held };
    row.appendChild(group);
    confirm.focus();
  }

  function clearConfirmation(restoreFocus) {
    if (confirmation === null) return;
    const open = confirmation;
    confirmation = null;
    open.group.remove();
    if (open.controls !== null && !busy && open.controls.isConnected) {
      for (const node of open.controls.querySelectorAll(".share-op")) node.disabled = open.held.has(node);
    }
    if (restoreFocus && open.initiator !== null && open.initiator.isConnected) open.initiator.focus();
  }

  function noop() {}

  /* One state machine serves every control. There is at most one in-flight
     request across mutation, session and roster work, no queue, no retry, and
     no response body is ever read from a mutation: the following GET owns
     every visible authoritative value. */
  async function sendMutation(method, path, body, isTransfer, onAccepted, options = {}) {
    const okStatus = options.okStatus === undefined ? 204 : options.okStatus;
    const reasonFor = options.reasonFor === undefined ? null : options.reasonFor;
    if (removed || busy || controller !== null) return;
    if (panel === null || panel.hidden || !ownerEligible()) return;
    let endpoint;
    try {
      endpoint = new URL(path, location.origin);
    } catch (error) {
      return;
    }
    if (endpoint.origin !== location.origin) return;

    const requestGeneration = generation;
    const requestController = new AbortController();
    busy = true;
    if (isTransfer) authorityAtRisk = true;
    controller = requestController;
    panel.setAttribute("aria-busy", "true");
    disableControlsForWrite();
    status.textContent = "Updating access…";
    const deadline = setTimeout(() => requestController.abort(), 15_000);
    let outcome = null;
    let rejectedCode = null;
    try {
      const response = await fetch(endpoint, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(body),
        signal: requestController.signal,
      });
      if (!isCurrent(requestGeneration)) return;
      const code = response.status;
      if (response.redirected === true) outcome = "ambiguous";
      else if (code === 401) outcome = "unauthorized";
      else if (code === 403) outcome = "forbidden";
      else if (code === okStatus) outcome = "ok";
      else if (code === 400 || code === 404 || code === 413 || code === 415 || code === 429
        || (code === 409 && !isTransfer)) outcome = "rejected";
      else outcome = "ambiguous";
      /* The one thing ever taken from a mutation response, and it is a closed
         enumeration rather than text: which of ACN-007's three domain-list
         refusals this was. The caller maps it to its own literals, so no string
         a server chose reaches the panel, and the roster read that follows
         still owns every value rendered. */
      if (outcome === "rejected" && code === 400 && reasonFor !== null) {
        rejectedCode = await readRefusalCode(response);
      }
    } catch (error) {
      if (isCurrent(requestGeneration)) outcome = "ambiguous";
    } finally {
      clearTimeout(deadline);
      busy = false;
      if (controller === requestController) controller = null;
    }
    if (outcome === null || !isCurrent(requestGeneration)) return;

    if (outcome === "unauthorized") {
      removeFeature();
      return;
    }
    if (outcome === "ok") {
      clearConfirmation(false);
      onAccepted();
      mutationMessage = "Access updated.";
    } else if (outcome === "forbidden") {
      mutationMessage = "Your access changed.";
    } else if (outcome === "rejected") {
      const named = reasonFor === null ? null : reasonFor(rejectedCode);
      mutationMessage = named === null ? "Access change was not accepted." : named;
    } else {
      mutationMessage = "Access change could not be completed.";
    }
    status.textContent = mutationMessage;
    pendingHeadingFocus = true;

    /* A completed transfer, an ambiguous transfer, and any write-time 403 all
       mean the cached owner authority may be a lie. Give it up before the read
       and let the server say what this session is now. */
    const reconcile = outcome === "forbidden"
      || (isTransfer && (outcome === "ok" || outcome === "ambiguous"));
    if (!reconcile) {
      if (isTransfer) authorityAtRisk = false;
      refreshRoster();
      return;
    }
    demoteAuthority();
    authorityAtRisk = true;
    if (!await refreshSession(requestGeneration)) return;
    refreshRoster();
  }

  async function reconcileThenRefresh() {
    const requestGeneration = generation;
    if (!await refreshSession(requestGeneration)) return;
    refreshRoster();
  }

  /* P2-C's exact session transport, repeated once. This is P4-L's deliberate
     successor exception to the single startup probe: it dispatches no event,
     touches no `data-session`, and amends no other module. */
  async function refreshSession(requestGeneration) {
    if (!isCurrent(requestGeneration) || controller !== null) return false;
    const endpoint = new URL("/api/session", location.href);
    endpoint.searchParams.set("doc", docId);
    const requestController = new AbortController();
    controller = requestController;
    const timer = setTimeout(() => requestController.abort(), 2_000);
    let refreshed = null;
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        mode: "same-origin",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: requestController.signal,
      });
      if (response.status === 200) {
        const header = response.headers.get("content-type");
        if (header !== null && isJsonContentType(header)) {
          const parsed = await response.json();
          refreshed = validFinalSession(parsed);
          if (refreshed !== null) deepFreeze(refreshed);
        }
      }
    } catch (error) {
      refreshed = null;
    } finally {
      clearTimeout(timer);
      if (controller === requestController) controller = null;
    }
    if (removed) return false;
    if (!isCurrent(requestGeneration)) {
      /* A close during reconciliation leaves authority unknown on purpose. */
      return false;
    }
    if (refreshed === null) {
      removeFeature();
      return false;
    }
    sessionRole = refreshed.role;
    mayShare = refreshed.canShare;
    maySeeMembers = refreshed.canSeeMembers;
    isShared = refreshed.shared;
    authorityUnknown = false;
    authorityAtRisk = false;
    if (!ownerEligible()) removeOwnerControls();
    return true;
  }

  /* The complete thirteen-field P3-H final session, plus the only two
     internally consistent shapes that may keep a Share surface open. */
  function validFinalSession(body) {
    if (!isRecord(body) || Object.getPrototypeOf(body) !== Object.prototype) return null;
    for (const field of FINAL_SESSION_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) return null;
    }
    if (typeof body.sub !== "string" || typeof body.email !== "string"
      || typeof body.name !== "string") return null;
    if (typeof body.canComment !== "boolean" || typeof body.canEdit !== "boolean") return null;
    if (body.doc !== docId) return null;
    if (!SESSION_ROLES.includes(body.role)) return null;
    if (typeof body.shared !== "boolean" || typeof body.canSuggest !== "boolean"
      || typeof body.canAccept !== "boolean" || typeof body.canShare !== "boolean"
      || typeof body.canSeeMembers !== "boolean") return null;
    if (body.shared !== true || body.canSeeMembers !== true) return null;
    const consistent = (body.role === "owner" && body.canShare === true)
      || (body.role === "editor" && body.canShare === false);
    return consistent ? body : null;
  }

  function deepFreeze(root) {
    const stack = [root];
    const ordered = [];
    while (stack.length > 0) {
      const current = stack.pop();
      ordered.push(current);
      for (const field of Object.keys(current)) {
        const child = current[field];
        if (child !== null && typeof child === "object") stack.push(child);
      }
    }
    for (let index = ordered.length - 1; index >= 0; index -= 1) Object.freeze(ordered[index]);
    return root;
  }

  /* P2-C's single accepted content-type grammar. */
  function isJsonContentType(value) {
    if (typeof value !== "string") return false;
    const length = value.length;
    let at = 0;
    const ows = () => {
      while (at < length) {
        const code = value.charCodeAt(at);
        if (code === 32 || code === 9) at += 1;
        else return;
      }
    };
    const lower = (code) => (code >= 65 && code <= 90 ? code + 32 : code);
    const word = (expected) => {
      if (at + expected.length > length) return false;
      for (let index = 0; index < expected.length; index += 1) {
        if (lower(value.charCodeAt(at)) !== expected.charCodeAt(index)) return false;
        at += 1;
      }
      return true;
    };
    ows();
    if (!word("application")) return false;
    if (at >= length || value.charCodeAt(at) !== 47) return false;
    at += 1;
    if (!word("json")) return false;
    ows();
    if (at === length) return true;
    if (value.charCodeAt(at) !== 59) return false;
    at += 1;
    ows();
    if (!word("charset")) return false;
    if (at >= length || value.charCodeAt(at) !== 61) return false;
    at += 1;
    if (at < length && value.charCodeAt(at) === 34) {
      at += 1;
      if (!word("utf-8")) return false;
      if (at >= length || value.charCodeAt(at) !== 34) return false;
      at += 1;
    } else if (!word("utf-8")) {
      return false;
    }
    ows();
    return at === length;
  }

  /**
   * The `error` code out of a refusal envelope, or `null`.
   *
   * Bounded to the grammar a code has -- short, lowercase, no separators but
   * `_` and `-` -- before it is compared against anything, so the value that
   * reaches a table lookup cannot be a long string a response chose. It is
   * never rendered: only the caller's own literal for a code it recognises is.
   */
  async function readRefusalCode(response) {
    const header = response.headers.get("content-type");
    if (header === null || !isJsonContentType(header)) return null;
    let parsed;
    try {
      parsed = await response.json();
    } catch (error) {
      return null;
    }
    if (!isRecord(parsed) || typeof parsed.error !== "string") return null;
    return /^[a-z][a-z0-9_-]{0,63}$/.test(parsed.error) ? parsed.error : null;
  }

  /* ACN-007's three domain-list refusals, in this panel's own words. The limit
     is deliberately not a number here: the number lives in `domain-access.mjs`
     and a copy of it in a browser is a copy that goes stale silently. */
  const DOMAIN_REFUSALS = {
    public_mailbox_domain:
      "That domain is a public mailbox provider, so listing it would admit anyone.",
    invalid_domain: "That is not a domain we can use.",
    too_many_domains: "That is more domains than a document can list.",
  };

  const ACCESS_PATH = "/api/access";
  const TRANSFER_PATH = "/api/access/transfer";
  const TRANSFER_WARNING = "Transfer ownership to this person? You will become an editor."
    + " If setup stops during transfer, the new owner may need to invite you again.";
  const FINAL_SESSION_FIELDS = [
    "sub", "email", "name", "canComment", "canEdit",
    "doc", "role", "shared", "canSuggest", "canAccept", "canShare", "canSeeMembers",
  ];
  const SESSION_ROLES = ["owner", "editor", "commenter", "viewer", "none"];
}

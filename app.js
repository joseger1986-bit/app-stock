const DEPOSITO_MINORISTA = "Depósito Minorista";
const DEFAULT_UNIT = "unidad";
const DEVICE_STORAGE_KEY = "app_stock_device";

const DEFAULT_STATE = {
  categorias: [],
  marcas: [],
  ubicaciones: [],
  productos: [],
  stock: [],
  remitos: [],
  devices: [],
  accessAccount: null,
  session: null,
  device: null,
  deviceStatus: null,
  isAdmin: false,
  transferItems: [],
  merchandiseMode: "existing",
  selectedMerchandiseProductId: null,
  selectedTransferProductId: null,
  lastConfirmedTransfer: null,
  isCreatingProduct: false,
  isSavingStockOperation: false,
  excelPreviewRows: [],
  isImportingExcel: false,
  isCreatingCategory: false,
  isEditingCategory: false,
  isAddingTransferItem: false,
  isConfirmingTransfer: false,
  stockSort: {
    field: "",
    direction: "asc"
  }
};

let supabaseClient = null;
let state = { ...DEFAULT_STATE };

document.addEventListener("DOMContentLoaded", () => {
  setupNavigation();
  setupTransferDate();
  setupSupabase();
  setupEvents();
  showScreen(getScreenFromLocation(), { push: false });
  initializeAuth();
});

function setupNavigation() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => navigateToScreen(button.dataset.screen));
  });

  window.addEventListener("popstate", () => {
    showScreen(getScreenFromLocation(), { push: false });
  });

  if (!location.hash) {
    history.replaceState({ screen: "stock" }, "", "#stock");
  }
}

function navigateToScreen(target) {
  showScreen(target, { push: true });
}

function showScreen(target, options = {}) {
  const requestedScreen = isValidScreen(target) ? target : "stock";
  const screen = requestedScreen === "dispositivos" && !state.isAdmin ? "stock" : requestedScreen;
  if (options.push && getScreenFromLocation() !== screen) {
    history.pushState({ screen }, "", `#${screen}`);
  }

  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.screen === screen);
  });

  document.querySelectorAll(".screen").forEach((section) => {
    section.classList.toggle("active", section.id === `screen-${screen}`);
  });

  if (screen === "dispositivos" && state.isAdmin) {
    loadAccessAccount();
    loadDevices();
  }
}

function getScreenFromLocation() {
  const screen = location.hash.replace("#", "").replace("/", "");
  return isValidScreen(screen) ? screen : "stock";
}

function isValidScreen(screen) {
  return Boolean(document.querySelector(`#screen-${screen}`));
}

function setupTransferDate() {
  const dateInput = document.querySelector("#transfer-date");
  if (dateInput) {
    dateInput.valueAsDate = new Date();
  }
}

function setupSupabase() {
  const status = document.querySelector("#connection-status");
  const config = window.APP_CONFIG || {};

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    status.textContent = "Supabase pendiente";
    status.className = "connection";
    return;
  }

  if (!window.supabase) {
    status.textContent = "Supabase no cargó";
    status.className = "connection error";
    return;
  }

  supabaseClient = createSupabaseClient(config);

  status.textContent = "Supabase conectado";
  status.className = "connection ok";
}

function createSupabaseClient(config) {
  const device = getStoredDevice();
  const headers = device
    ? {
        "x-app-device-id": device.id,
        "x-app-device-secret": device.secret
      }
    : {};

  return window.supabase.createClient(
    config.supabaseUrl,
    config.supabaseAnonKey,
    {
      global: { headers },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );
}

async function initializeAuth() {
  if (!supabaseClient) {
    showLoginScreen();
    return;
  }

  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data.session) {
    showLoginScreen();
    return;
  }

  state.session = data.session;
  await verifyCurrentDevice();
}

async function login() {
  clearMessage("#auth-message");
  const user = cleanValue("#login-user");
  const password = document.querySelector("#login-password")?.value || "";

  if (!user || !password) {
    showMessage("#auth-message", "Ingresá usuario y contraseña.", "error");
    return;
  }

  try {
    setButtonBusy("#login-button", true, "Ingresando...");
    const email = await resolveLoginEmail(user);
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);

    state.session = data.session;
    document.querySelector("#login-password").value = "";
    await verifyCurrentDevice();
  } catch (error) {
    showMessage("#auth-message", error.message, "error");
  } finally {
    setButtonBusy("#login-button", false);
  }
}

async function resolveLoginEmail(user) {
  const normalizedUser = user.trim().toLowerCase();
  if (normalizedUser.includes("@")) return normalizedUser;

  const { data, error } = await supabaseClient.rpc("app_login_email_for_username", {
    p_usuario: normalizedUser
  });

  if (error) {
    throw new Error("No se pudo validar el usuario. Revisá que esté ejecutado el SQL de usuario único.");
  }

  const email = data?.[0]?.email;
  if (!email) {
    throw new Error("Usuario o contraseña incorrectos.");
  }

  return email;
}

async function logout() {
  clearMessage("#auth-message");
  await supabaseClient?.auth.signOut();
  state = {
    ...state,
    session: null,
    deviceStatus: null,
    isAdmin: false,
    devices: [],
    accessAccount: null,
    categorias: [],
    marcas: [],
    ubicaciones: [],
    productos: [],
    stock: [],
    remitos: [],
    transferItems: []
  };
  showLoginScreen();
}

async function verifyCurrentDevice() {
  clearMessage("#auth-message");

  const device = ensureStoredDevice();
  state.device = device;
  await refreshSupabaseClientWithDevice();

  try {
    let status = await fetchCurrentDeviceStatus(device);
    if (!status) {
      status = await registerCurrentDevice(device);
    }

    state.deviceStatus = status;
    state.isAdmin = Boolean(status.is_admin);

    if (status.estado !== "aprobado") {
      showPendingDevice(status);
      return;
    }

    showAuthenticatedApp();
    await loadInitialData();
    if (state.isAdmin) {
      await loadAccessAccount();
      await loadDevices();
    }
  } catch (error) {
    showLoginScreen();
    showMessage("#auth-message", error.message, "error");
  }
}

async function fetchCurrentDeviceStatus(device) {
  const { data, error } = await supabaseClient.rpc("app_current_device_status", {
    p_device_id: device.id,
    p_device_secret: device.secret
  });

  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

async function registerCurrentDevice(device) {
  const { data, error } = await supabaseClient.rpc("app_register_device", {
    p_device_id: device.id,
    p_device_secret: device.secret,
    p_nombre: document.querySelector("#device-name")?.value?.trim() || null
  });

  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

async function updatePendingDeviceName() {
  clearMessage("#auth-message");
  const device = ensureStoredDevice();

  try {
    setButtonBusy("#update-device-name", true, "Guardando...");
    const status = await registerCurrentDevice(device);
    state.deviceStatus = status;
    showPendingDevice(status);
    showMessage("#auth-message", "Nombre guardado. El dispositivo sigue pendiente de aprobación.", "ok");
  } catch (error) {
    showMessage("#auth-message", error.message, "error");
  } finally {
    setButtonBusy("#update-device-name", false);
  }
}

function showLoginScreen() {
  document.querySelector("#auth-screen")?.classList.remove("hidden");
  document.querySelector("#main-nav")?.classList.add("hidden");
  document.querySelector("#app-shell")?.classList.add("hidden");
  document.querySelector("#device-pending")?.classList.add("hidden");
  document.querySelectorAll(".admin-only").forEach((item) => item.classList.add("hidden"));
}

function showPendingDevice(status) {
  document.querySelector("#auth-screen")?.classList.remove("hidden");
  document.querySelector("#main-nav")?.classList.add("hidden");
  document.querySelector("#app-shell")?.classList.add("hidden");
  document.querySelector("#device-pending")?.classList.remove("hidden");
  const nameInput = document.querySelector("#device-name");
  const deviceId = document.querySelector("#current-device-id");
  if (nameInput) nameInput.value = status?.nombre || "";
  if (deviceId) deviceId.textContent = status?.id || state.device?.id || "-";
  showMessage("#auth-message", "Este dispositivo todavía no está autorizado.", "error");
}

function showAuthenticatedApp() {
  document.querySelector("#auth-screen")?.classList.add("hidden");
  document.querySelector("#main-nav")?.classList.remove("hidden");
  document.querySelector("#app-shell")?.classList.remove("hidden");
  document.querySelectorAll(".admin-only").forEach((item) => {
    item.classList.toggle("hidden", !state.isAdmin);
  });
  if (!state.isAdmin && getScreenFromLocation() === "dispositivos") {
    history.replaceState({ screen: "stock" }, "", "#stock");
  }
  showScreen(getScreenFromLocation(), { push: false });
}

function ensureStoredDevice() {
  const existing = getStoredDevice();
  if (existing) return existing;

  const device = {
    id: crypto.randomUUID(),
    secret: generateDeviceSecret()
  };
  localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(device));
  return device;
}

function getStoredDevice() {
  try {
    const device = JSON.parse(localStorage.getItem(DEVICE_STORAGE_KEY) || "null");
    if (device?.id && device?.secret) return device;
  } catch {
    return null;
  }
  return null;
}

function generateDeviceSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function refreshSupabaseClientWithDevice() {
  const config = window.APP_CONFIG || {};
  if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase) return;
  const currentSession = state.session;
  supabaseClient = createSupabaseClient(config);
  if (currentSession?.access_token && currentSession?.refresh_token) {
    await supabaseClient.auth.setSession({
      access_token: currentSession.access_token,
      refresh_token: currentSession.refresh_token
    });
  }
}

async function loadDevices() {
  if (!state.isAdmin) return;

  const { data, error } = await supabaseClient.rpc("app_list_devices");
  if (error) {
    showMessage("#devices-message", error.message, "error");
    return;
  }

  state.devices = data || [];
  renderDevices();
}

async function loadAccessAccount() {
  if (!state.isAdmin) return;

  const { data, error } = await supabaseClient.rpc("app_get_access_account");
  if (error) {
    showMessage("#account-message", error.message, "error");
    return;
  }

  state.accessAccount = data?.[0] || null;
  renderAccessAccount();
}

function renderAccessAccount() {
  const input = document.querySelector("#access-username");
  if (input) input.value = state.accessAccount?.username || "";
}

function renderDevices() {
  const tbody = document.querySelector("#devices-table");
  if (!tbody) return;

  if (!state.isAdmin) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No autorizado.</td></tr>';
    return;
  }

  if (!state.devices.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No hay dispositivos para mostrar.</td></tr>';
    return;
  }

  tbody.innerHTML = state.devices.map((device) => `
    <tr>
      <td>
        <input class="device-name-input" type="text" value="${escapeHtml(device.nombre || "")}" placeholder="Dispositivo nuevo" data-device-name="${device.id}">
      </td>
      <td>${escapeHtml(getDeviceUserLabel(device))}</td>
      <td>${escapeHtml(formatDateTime(device.fecha_solicitud))}</td>
      <td><span class="status-badge status-${escapeHtml(device.estado)}">${escapeHtml(deviceStatusLabel(device.estado))}</span></td>
      <td>${escapeHtml(formatDateTime(device.ultimo_acceso) || "-")}</td>
      <td>
        <div class="table-actions">
          <button class="row-action neutral" type="button" data-device-action="rename" data-device-id="${device.id}">Guardar nombre</button>
          ${device.estado !== "aprobado" ? `<button class="row-action neutral" type="button" data-device-action="approve" data-device-id="${device.id}">Aprobar</button>` : ""}
          ${device.estado !== "revocado" ? `<button class="row-action" type="button" data-device-action="revoke" data-device-id="${device.id}">Revocar</button>` : ""}
        </div>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll("[data-device-action]").forEach((button) => {
    button.addEventListener("click", () => handleDeviceAction(button));
  });
}

async function handleDeviceAction(button) {
  if (button.disabled) return;
  clearMessage("#devices-message");
  const id = button.dataset.deviceId;
  const action = button.dataset.deviceAction;

  try {
    button.disabled = true;

    if (action === "rename") {
      const name = document.querySelector(`[data-device-name="${id}"]`)?.value || "";
      const { error } = await supabaseClient.rpc("app_rename_device", {
        p_device_id: id,
        p_nombre: name
      });
      if (error) throw new Error(error.message);
      showMessage("#devices-message", "Nombre actualizado.", "ok");
    } else {
      const status = action === "approve" ? "aprobado" : "revocado";
      const { error } = await supabaseClient.rpc("app_set_device_status", {
        p_device_id: id,
        p_estado: status
      });
      if (error) throw new Error(error.message);
      showMessage("#devices-message", status === "aprobado" ? "Dispositivo aprobado." : "Dispositivo revocado.", "ok");
    }

    await loadDevices();
  } catch (error) {
    showMessage("#devices-message", error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function saveAccessUsername() {
  clearMessage("#account-message");
  const username = cleanValue("#access-username");

  if (!username) {
    showMessage("#account-message", "El usuario no puede estar vacío.", "error");
    return;
  }

  try {
    setButtonBusy("#save-access-username", true, "Guardando...");
    const { data, error } = await supabaseClient.rpc("app_update_access_username", {
      p_username: username
    });
    if (error) throw new Error(error.message);

    state.accessAccount = data?.[0] || { ...state.accessAccount, username };
    renderAccessAccount();
    showMessage("#account-message", "Usuario actualizado. Los dispositivos autorizados se mantienen.", "ok");
  } catch (error) {
    showMessage("#account-message", error.message, "error");
  } finally {
    setButtonBusy("#save-access-username", false);
  }
}

async function changeAccessPassword() {
  clearMessage("#account-message");
  const password = document.querySelector("#access-password")?.value || "";
  const repeat = document.querySelector("#access-password-repeat")?.value || "";

  if (password.length < 6) {
    showMessage("#account-message", "La contraseña debe tener al menos 6 caracteres.", "error");
    return;
  }

  if (password !== repeat) {
    showMessage("#account-message", "Las contraseñas no coinciden.", "error");
    return;
  }

  try {
    setButtonBusy("#change-access-password", true, "Guardando...");
    const { error } = await supabaseClient.auth.updateUser({ password });
    if (error) throw new Error(error.message);

    document.querySelector("#access-password").value = "";
    document.querySelector("#access-password-repeat").value = "";
    showMessage("#account-message", "Contraseña actualizada. Los dispositivos autorizados se mantienen.", "ok");
  } catch (error) {
    showMessage("#account-message", error.message, "error");
  } finally {
    setButtonBusy("#change-access-password", false);
  }
}

function deviceStatusLabel(status) {
  if (status === "aprobado") return "Aprobado";
  if (status === "revocado") return "Revocado";
  return "Pendiente";
}

function getDeviceUserLabel(device) {
  if (state.accessAccount?.username) return state.accessAccount.username;
  return device.user_email || "-";
}

function setupEvents() {
  document.querySelector("#login-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    login();
  });

  document
    .querySelector("#logout-button")
    ?.addEventListener("click", logout);

  document
    .querySelector("#refresh-device-status")
    ?.addEventListener("click", verifyCurrentDevice);

  document
    .querySelector("#update-device-name")
    ?.addEventListener("click", updatePendingDeviceName);

  document
    .querySelector("#refresh-devices")
    ?.addEventListener("click", loadDevices);

  document
    .querySelector("#save-access-username")
    ?.addEventListener("click", saveAccessUsername);

  document
    .querySelector("#change-access-password")
    ?.addEventListener("click", changeAccessPassword);

  document.querySelectorAll("[data-merchandise-mode]").forEach((button) => {
    button.addEventListener("click", () => setMerchandiseMode(button.dataset.merchandiseMode));
  });

  document
    .querySelector("#save-merchandise")
    ?.addEventListener("click", saveMerchandise);

  document
    .querySelector("#confirm-stock-operation")
    ?.addEventListener("click", confirmExistingStockOperation);

  document
    .querySelector("#download-excel-template")
    ?.addEventListener("click", downloadExcelTemplate);

  document
    .querySelector("#import-excel-button")
    ?.addEventListener("click", () => document.querySelector("#excel-import-input")?.click());

  document
    .querySelector("#excel-import-input")
    ?.addEventListener("change", handleExcelFile);

  document
    .querySelector("#confirm-excel-import")
    ?.addEventListener("click", confirmExcelImport);

  document
    .querySelector("#cancel-excel-import")
    ?.addEventListener("click", clearExcelPreview);

  document
    .querySelector("#show-new-category")
    ?.addEventListener("click", openNewCategoryPanel);

  document
    .querySelector("#save-new-category")
    ?.addEventListener("click", saveNewCategory);

  document
    .querySelector("#show-edit-category")
    ?.addEventListener("click", openCategoryEditPanel);

  document
    .querySelector("#save-category-edit")
    ?.addEventListener("click", saveCategoryEdit);

  document
    .querySelector("#cancel-category-edit")
    ?.addEventListener("click", closeCategoryPanels);

  document
    .querySelector("#merchandise-product-category")
    ?.addEventListener("change", updateCategoryActionState);

  document
    .querySelector("#new-category-name")
    ?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveNewCategory();
      }
    });

  document
    .querySelector("#edit-category-name")
    ?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveCategoryEdit();
      }
    });

  document.querySelectorAll('input[name="stock-operation"]').forEach((input) => {
    input.addEventListener("change", updateStockOperationButton);
  });

  document
    .querySelector("#edit-product")
    ?.addEventListener("click", openProductEdit);

  document
    .querySelector("#duplicate-product")
    ?.addEventListener("click", duplicateSelectedProduct);

  document
    .querySelector("#save-product-edit")
    ?.addEventListener("click", saveProductEdit);

  document
    .querySelector("#cancel-product-edit")
    ?.addEventListener("click", closeProductEdit);

  document.querySelector("#merchandise-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.merchandiseMode === "new") {
      saveMerchandise();
    } else {
      confirmExistingStockOperation();
    }
  });

  document.querySelector("#merchandise-product-search")?.addEventListener("input", () => {
    state.selectedMerchandiseProductId = null;
    closeProductEdit();
    renderMerchandiseProductOptions();
    updateMerchandiseQuantityLabel();
    renderMerchandiseProductSummary();
  });

  ["#merchandise-category-filter", "#merchandise-brand-filter"].forEach((selector) => {
    document.querySelector(selector)?.addEventListener("input", () => {
      state.selectedMerchandiseProductId = null;
      closeProductEdit();
      renderMerchandiseProductOptions();
      updateMerchandiseQuantityLabel();
      renderMerchandiseProductSummary();
    });
  });

  document
    .querySelector("#merchandise-unit")
    ?.addEventListener("change", updateMerchandiseQuantityLabel);

  [
    "#stock-search",
    "#stock-category-filter",
    "#stock-brand-filter",
    "#stock-show-inactive"
  ].forEach((selector) => {
    document.querySelector(selector)?.addEventListener("input", renderStockTable);
  });

  document.querySelectorAll("[data-stock-sort]").forEach((button) => {
    button.addEventListener("click", () => setStockSort(button.dataset.stockSort));
  });

  document
    .querySelector("#stock-mobile-sort")
    ?.addEventListener("change", setStockMobileSort);

  [
    "#transfer-origin",
    "#transfer-destination",
    "#transfer-product-search",
    "#transfer-category-filter",
    "#transfer-brand-filter"
  ].forEach((selector) => {
    document.querySelector(selector)?.addEventListener("input", () => {
      state.selectedTransferProductId = null;
      renderTransferProductOptions();
      updateTransferAvailable();
      updateConfirmTransferButton();
    });
  });

  document
    .querySelector("#add-transfer-item")
    ?.addEventListener("click", addTransferItem);

  document
    .querySelector("#confirm-transfer")
    ?.addEventListener("click", confirmTransfer);

  document
    .querySelector("#new-transfer")
    ?.addEventListener("click", startNewTransfer);

  document.querySelectorAll("[data-receipt-action]").forEach((button) => {
    button.addEventListener("click", () => handleReceiptAction(button.dataset.receiptAction, state.lastConfirmedTransfer));
  });

  ["#remito-search", "#remito-date-from", "#remito-date-to"].forEach((selector) => {
    document.querySelector(selector)?.addEventListener("input", renderRemitos);
  });
}

async function loadInitialData() {
  if (!supabaseClient) {
    renderAll();
    return;
  }

  const [categorias, marcas, ubicaciones, productos, stock, remitos] = await Promise.all([
    fetchTable("categorias"),
    fetchTable("marcas"),
    fetchTable("ubicaciones"),
    fetchProducts(),
    fetchStock(),
    fetchRemitos()
  ]);

  state = {
    ...state,
    categorias,
    marcas,
    ubicaciones,
    productos,
    stock,
    remitos
  };

  renderAll();
}

async function fetchTable(tableName) {
  const { data, error } = await supabaseClient
    .from(tableName)
    .select("*")
    .order("nombre", { ascending: true });

  if (error) {
    setConnectionError(error.message);
    return [];
  }

  return data || [];
}

async function fetchProducts() {
  const { data, error } = await supabaseClient
    .from("productos")
    .select(`
      *,
      categorias(nombre),
      marcas(nombre)
    `)
    .order("nombre", { ascending: true });

  if (error) {
    setConnectionError(error.message);
    return [];
  }

  return data || [];
}

async function fetchStock() {
  const { data, error } = await supabaseClient
    .from("stock")
    .select(`
      *,
      productos(
        id,
        nombre,
        activo,
        categoria_id,
        marca_id,
        unidad_stock,
        categorias(nombre),
        marcas(nombre)
      ),
      ubicaciones(id, nombre, activo)
    `)
    .order("cantidad", { ascending: true });

  if (error) {
    setConnectionError(error.message);
    return [];
  }

  return data || [];
}

async function fetchRemitos() {
  const { data, error } = await supabaseClient
    .from("transferencias")
    .select(`
      id,
      numero,
      fecha,
      created_at,
      origen:ubicaciones!transferencias_origen_id_fkey(nombre),
      destino:ubicaciones!transferencias_destino_id_fkey(nombre),
      transferencia_detalle(
        id,
        cantidad,
        productos(
          id,
          nombre,
          unidad_stock,
          categorias(nombre),
          marcas(nombre)
        )
      )
    `)
    .order("created_at", { ascending: false });

  if (error) {
    setConnectionError(error.message);
    return [];
  }

  return (data || []).map(normalizeRemito);
}

async function fetchRemitoById(id) {
  const { data, error } = await supabaseClient
    .from("transferencias")
    .select(`
      id,
      numero,
      fecha,
      created_at,
      origen:ubicaciones!transferencias_origen_id_fkey(nombre),
      destino:ubicaciones!transferencias_destino_id_fkey(nombre),
      transferencia_detalle(
        id,
        cantidad,
        productos(
          id,
          nombre,
          unidad_stock,
          categorias(nombre),
          marcas(nombre)
        )
      )
    `)
    .eq("id", id)
    .single();

  if (error) throw new Error(error.message);
  return normalizeRemito(data);
}

function normalizeRemito(row) {
  return {
    id: row.id,
    numero: row.numero,
    fecha: row.fecha,
    created_at: row.created_at,
    origen: row.origen?.nombre || "",
    destino: row.destino?.nombre || "",
    detalles: (row.transferencia_detalle || []).map((detail) => ({
      id: detail.id,
      cantidad: Number(detail.cantidad || 0),
      producto_id: detail.productos?.id || "",
      articulo: detail.productos?.nombre || "",
      unidad_stock: getProductUnit(detail.productos),
      categoria: detail.productos?.categorias?.nombre || "",
      marca: detail.productos?.marcas?.nombre || ""
    }))
  };
}

function renderAll() {
  renderSelects();
  setDefaultTransferOrigin();
  renderBrandOptions();
  renderLocations();
  renderMerchandiseProductOptions();
  renderStockTable();
  renderTransferProductOptions();
  renderTransferItems();
  renderRemitos();
  renderDevices();
  updateMerchandiseQuantityLabel();
  renderMerchandiseProductSummary();
  updateStockOperationButton();
  updateTransferAvailable();
  updateConfirmTransferButton();
}

function renderSelects() {
  fillSelect("#stock-category-filter", state.categorias, "Todas las categorías");
  fillSelect("#stock-brand-filter", state.marcas, "Todas las marcas");
  fillSelect("#transfer-origin", state.ubicaciones, "Elegir origen");
  fillSelect("#transfer-destination", state.ubicaciones, "Elegir destino");
  fillSelect("#transfer-category-filter", state.categorias, "Todas las categorías");
  fillSelect("#transfer-brand-filter", state.marcas, "Todas las marcas");
  fillSelect("#merchandise-category-filter", state.categorias, "Todas las categorías");
  fillSelect("#merchandise-brand-filter", state.marcas, "Todas las marcas");
  fillSelect("#merchandise-product-category", state.categorias, "Sin categoría");
  fillSelect("#edit-product-category", state.categorias, "Sin categoría");
  updateCategoryActionState();
}

function setDefaultTransferOrigin() {
  const select = document.querySelector("#transfer-origin");
  if (!select || select.value) return;

  const deposit = state.ubicaciones.find((item) => item.nombre === DEPOSITO_MINORISTA);
  if (deposit) select.value = deposit.id;
}

function fillSelect(selector, items, firstLabel) {
  const select = document.querySelector(selector);
  if (!select) return;

  const currentValue = select.value;
  select.innerHTML = "";
  select.append(new Option(firstLabel, ""));

  items
    .filter((item) => item.activo !== false)
    .forEach((item) => {
      select.append(new Option(item.nombre, item.id));
    });

  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  } else {
    select.value = "";
  }
}

function renderBrandOptions() {
  const datalist = document.querySelector("#brand-options");
  if (!datalist) return;

  datalist.innerHTML = state.marcas
    .filter((marca) => marca.activo !== false)
    .map((marca) => `<option value="${escapeHtml(marca.nombre)}"></option>`)
    .join("");
}

function renderLocations() {
  const list = document.querySelector("#locations-list");
  if (!list) return;

  if (!state.ubicaciones.length) {
    list.innerHTML = "<li><span>No hay ubicaciones cargadas.</span></li>";
    return;
  }

  list.innerHTML = state.ubicaciones
    .map((ubicacion) => {
      const estado = ubicacion.activo ? "Activa" : "Inactiva";
      return `<li><span>${escapeHtml(ubicacion.nombre)}</span><span class="badge">${estado}</span></li>`;
    })
    .join("");
}

function setMerchandiseMode(mode) {
  state.merchandiseMode = mode;
  state.selectedMerchandiseProductId = null;
  clearMessage("#merchandise-message");

  document.querySelectorAll("[data-merchandise-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.merchandiseMode === mode);
  });

  document.querySelector("#existing-product-section")?.classList.toggle("hidden", mode !== "existing");
  document.querySelector("#new-product-section")?.classList.toggle("hidden", mode !== "new");
  document.querySelector("#stock-operation")?.classList.toggle("hidden", mode !== "existing");
  document.querySelector("#edit-product")?.classList.add("hidden");
  document.querySelector("#confirm-stock-operation")?.classList.toggle("hidden", mode !== "existing");
  document.querySelector("#save-merchandise")?.classList.toggle("hidden", mode !== "new");
  document.querySelector("#merchandise-form")?.reset();
  closeProductEdit();
  closeCategoryPanels();

  renderMerchandiseProductOptions();
  updateMerchandiseQuantityLabel();
  renderMerchandiseProductSummary();
  updateStockOperationButton();
}

function renderMerchandiseProductOptions() {
  const list = document.querySelector("#merchandise-suggestions");
  if (!list) return;

  const search = normalizeText(document.querySelector("#merchandise-product-search")?.value || "");
  const categoryId = document.querySelector("#merchandise-category-filter")?.value || "";
  const brandId = document.querySelector("#merchandise-brand-filter")?.value || "";

  if (!search || state.selectedMerchandiseProductId) {
    list.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  const products = getRankedProducts(search)
    .filter((product) => product.activo !== false)
    .filter((product) => !categoryId || product.categoria_id === categoryId)
    .filter((product) => !brandId || product.marca_id === brandId)
    .slice(0, search ? 8 : 5);

  if (!products.length) {
    list.classList.remove("hidden");
    list.innerHTML = '<div class="empty">No encontré productos relacionados.</div>';
    return;
  }

  list.classList.remove("hidden");
  list.innerHTML = products.map(renderProductSuggestion).join("");

  list.querySelectorAll("[data-select-product]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedMerchandiseProductId = button.dataset.selectProduct;
      closeProductEdit();
      renderMerchandiseProductOptions();
      updateMerchandiseQuantityLabel();
      renderMerchandiseProductSummary();
      document.querySelector("#merchandise-quantity")?.focus();
    });
  });
}

function renderProductSuggestion(product) {
  const brand = product.marcas?.nombre || "";
  const category = product.categorias?.nombre || "";
  const unit = unitLabel(getProductUnit(product)).toUpperCase();
  const meta = [brand, category, unit].filter(Boolean).join(" · ");
  const selected = product.id === state.selectedMerchandiseProductId ? " selected" : "";

  return `
    <button class="suggestion-button${selected}" type="button" data-select-product="${product.id}">
      <strong>${escapeHtml(product.nombre)}</strong>
      <span class="suggestion-meta">${escapeHtml(meta)}</span>
    </button>
  `;
}

function renderMerchandiseProductSummary() {
  const summary = document.querySelector("#merchandise-product-summary");
  const editButton = document.querySelector("#edit-product");
  const duplicateButton = document.querySelector("#duplicate-product");
  if (!summary) return;

  const product = getSelectedMerchandiseProduct();

  if (!product) {
    summary.classList.add("hidden");
    summary.innerHTML = "";
    editButton?.classList.add("hidden");
    duplicateButton?.classList.add("hidden");
    return;
  }

  summary.classList.remove("hidden");
  editButton?.classList.remove("hidden");
  duplicateButton?.classList.remove("hidden");
  const brand = product.marcas?.nombre || "";
  const category = product.categorias?.nombre || "";
  const unit = getProductUnit(product);

  summary.innerHTML = `
    <strong>${escapeHtml(product.nombre)}</strong>
    ${brand ? `<span>Marca: ${escapeHtml(brand)}</span>` : ""}
    ${category ? `<span>Categoría: ${escapeHtml(category)}</span>` : ""}
    <span class="unit-pill">Se maneja por: ${escapeHtml(unitLabel(unit))}</span>
  `;
}

function updateMerchandiseQuantityLabel() {
  const label = document.querySelector("#merchandise-quantity-label");
  if (!label) return;

  label.textContent = "Cantidad";
}

function duplicateSelectedProduct() {
  const product = getSelectedMerchandiseProduct();
  if (!product) return;

  setMerchandiseMode("new");

  document.querySelector("#merchandise-product-name").value = product.nombre || "";
  document.querySelector("#merchandise-product-category").value = product.categoria_id || "";
  document.querySelector("#merchandise-product-brand").value = product.marcas?.nombre || "";
  document.querySelector("#merchandise-unit").value = getProductUnit(product);
  document.querySelector("#merchandise-cost").value = product.costo ?? "";
  document.querySelector("#merchandise-price").value = product.precio_venta ?? "";
  document.querySelector("#merchandise-min-stock").value = product.stock_minimo ?? "";
  document.querySelector("#merchandise-quantity").value = "";

  updateCategoryActionState();
  updateMerchandiseQuantityLabel();
  document.querySelector("#merchandise-product-name")?.focus();
  showMessage("#merchandise-message", "Producto duplicado en el formulario. Revisá los datos y cargá la cantidad antes de crear.", "ok");
}

async function saveMerchandise() {
  if (state.isCreatingProduct) return;
  clearMessage("#merchandise-message");

  if (!supabaseClient) {
    showMessage("#merchandise-message", "Configurá Supabase antes de guardar.", "error");
    return;
  }

  const quantity = readNumber("#merchandise-quantity", 0);
  const deposit = state.ubicaciones.find((item) => item.nombre === DEPOSITO_MINORISTA);

  if (!deposit) {
    showMessage("#merchandise-message", "No se encontró la ubicación Depósito Minorista.", "error");
    return;
  }

  if (state.merchandiseMode !== "new") {
    await confirmExistingStockOperation();
    return;
  }

  try {
    setButtonBusy("#save-merchandise", true, "Guardando...");
    state.isCreatingProduct = true;

    const productId = await createProductFromMerchandise();

    await updateStockInLocation(productId, deposit.id, quantity);
    if (quantity > 0) {
      await insertStockMovement(productId, deposit.id, "ingreso", quantity);
    }
    await loadInitialData();

    state.selectedMerchandiseProductId = null;
    document.querySelector("#merchandise-form").reset();
    renderMerchandiseProductSummary();
    showMessage("#merchandise-message", "Producto creado correctamente.", "ok");
    showScreen("stock");
  } catch (error) {
    showMessage("#merchandise-message", error.message, "error");
  } finally {
    state.isCreatingProduct = false;
    setButtonBusy("#save-merchandise", false);
  }
}

async function confirmExistingStockOperation() {
  if (state.isSavingStockOperation) return;
  clearMessage("#merchandise-message");

  if (!supabaseClient) {
    showMessage("#merchandise-message", "Configurá Supabase antes de guardar.", "error");
    return;
  }

  const productId = state.selectedMerchandiseProductId;
  const deposit = state.ubicaciones.find((item) => item.nombre === DEPOSITO_MINORISTA);
  const quantity = readNumber("#merchandise-quantity", 0);

  if (!productId) {
    showMessage("#merchandise-message", "Elegí un producto existente.", "error");
    return;
  }

  if (!deposit) {
    showMessage("#merchandise-message", "No se encontró la ubicación Depósito Minorista.", "error");
    return;
  }

  if (quantity <= 0) {
    showMessage("#merchandise-message", "La cantidad debe ser mayor a cero.", "error");
    return;
  }

  const operation = getStockOperation();
  const currentStock = getAvailableStock(productId, deposit.id);
  const quantityChange = operation === "subtract" ? quantity * -1 : quantity;

  if (operation === "subtract" && quantity > currentStock) {
    showMessage("#merchandise-message", "No hay stock suficiente para restar esa cantidad.", "error");
    return;
  }

  try {
    setButtonBusy("#confirm-stock-operation", true, "Guardando...");
    state.isSavingStockOperation = true;

    await updateStockInLocation(productId, deposit.id, quantityChange);
    await insertStockMovement(
      productId,
      deposit.id,
      operation === "subtract" ? "ajuste" : "ingreso",
      quantityChange
    );
    await loadInitialData();
    state.selectedMerchandiseProductId = productId;
    document.querySelector("#merchandise-quantity").value = "";
    renderMerchandiseProductOptions();
    renderMerchandiseProductSummary();
    showMessage("#merchandise-message", "Operación registrada correctamente.", "ok");
  } catch (error) {
    showMessage("#merchandise-message", error.message, "error");
  } finally {
    state.isSavingStockOperation = false;
    setButtonBusy("#confirm-stock-operation", false);
  }
}

function downloadExcelTemplate() {
  const headers = getExcelHeaders();
  const rows = [
    {
      "Nombre del artículo": "Boxer Elemento 201",
      "Categoría": "",
      "Marca": "Elemento",
      "Unidad de stock": "Docena",
      "Precio de costo": "",
      "Precio de venta": "",
      "Stock mínimo": "",
      "Cantidad a ingresar": 6
    },
    {
      "Nombre del artículo": "Toallón",
      "Categoría": "",
      "Marca": "",
      "Unidad de stock": "Unidad",
      "Precio de costo": "",
      "Precio de venta": "",
      "Stock mínimo": "",
      "Cantidad a ingresar": ""
    }
  ];

  if (!window.XLSX) {
    const csv = [
      headers.join(","),
      ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
    ].join("\n");
    downloadBlob(csv, "plantilla-importacion-mercaderia.csv", "text/csv;charset=utf-8");
    return;
  }

  const worksheet = window.XLSX.utils.json_to_sheet(rows, { header: headers });
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "Mercadería");
  window.XLSX.writeFile(workbook, "plantilla-importacion-mercaderia.xlsx");
}

async function handleExcelFile(event) {
  clearMessage("#merchandise-message");
  const file = event.target.files?.[0];
  if (!file) return;

  if (!window.XLSX) {
    showMessage("#merchandise-message", "No se pudo cargar el lector de Excel. Revisá la conexión y volvé a intentar.", "error");
    return;
  }

  try {
    const rows = await readExcelRows(file);
    state.excelPreviewRows = buildExcelPreviewRows(rows);
    renderExcelPreview();
  } catch (error) {
    clearExcelPreview();
    showMessage("#merchandise-message", error.message, "error");
  }
}

function readExcelRows(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const workbook = window.XLSX.read(reader.result, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
        resolve(rows);
      } catch (error) {
        reject(new Error(`No se pudo leer el archivo: ${error.message}`));
      }
    };

    reader.onerror = () => reject(new Error("No se pudo leer el archivo seleccionado."));
    reader.readAsArrayBuffer(file);
  });
}

function buildExcelPreviewRows(rows) {
  if (!rows.length) throw new Error("El archivo no tiene filas para importar.");

  const previewRows = rows.map((rawRow, index) => {
    const normalized = normalizeExcelRow(rawRow);
    const row = {
      rowNumber: index + 2,
      nombre: normalized.nombre,
      categoria: normalized.categoria,
      marca: normalized.marca,
      unidad_stock: normalizeUnit(normalized.unidad_stock),
      costo: parseExcelNumber(normalized.costo, "Precio de costo"),
      precio_venta: parseExcelNumber(normalized.precio_venta, "Precio de venta"),
      stock_minimo: parseExcelNumber(normalized.stock_minimo, "Stock mínimo"),
      cantidad: parseExcelNumber(normalized.cantidad, "Cantidad a ingresar"),
      product: null,
      duplicateOfRow: null,
      category: null,
      status: "Producto nuevo",
      statusType: "new",
      problem: ""
    };

    validateExcelRow(row);
    classifyExcelRow(row);
    return row;
  });

  markRepeatedExcelProducts(previewRows);
  return previewRows;
}

function normalizeExcelRow(rawRow) {
  const normalized = {};
  Object.entries(rawRow).forEach(([key, value]) => {
    normalized[normalizeColumnName(key)] = String(value ?? "").trim();
  });

  return {
    nombre: findExcelColumnValue(normalized, ["nombre del articulo", "nombre articulo"], ["nombre", "art"]),
    categoria: findExcelColumnValue(normalized, ["categoria"], ["categor"]),
    marca: findExcelColumnValue(normalized, ["marca"], ["marca"]),
    unidad_stock: findExcelColumnValue(normalized, ["unidad de stock", "unidad stock"], ["unidad", "stock"]),
    costo: findExcelColumnValue(normalized, ["precio de costo", "costo"], ["costo"]),
    precio_venta: findExcelColumnValue(normalized, ["precio de venta", "venta"], ["venta"]),
    stock_minimo: findExcelColumnValue(normalized, ["stock minimo"], ["stock", "min"]),
    cantidad: findExcelColumnValue(normalized, ["cantidad a ingresar", "cantidad ingresar"], ["cantidad", "ingresar"])
  };
}

function findExcelColumnValue(normalizedRow, exactNames, requiredParts) {
  for (const name of exactNames) {
    if (Object.prototype.hasOwnProperty.call(normalizedRow, name)) return normalizedRow[name];
  }

  const entry = Object.entries(normalizedRow).find(([key]) =>
    requiredParts.every((part) => key.includes(part))
  );

  return entry?.[1] || "";
}

function validateExcelRow(row) {
  const problems = [];

  if (!row.nombre) problems.push("Falta el nombre del artículo.");
  if (!row.unidad_stock) problems.push("La unidad de stock debe ser Unidad o Docena.");

  ["costo", "precio_venta", "stock_minimo", "cantidad"].forEach((field) => {
    if (row[field]?.error) problems.push(row[field].error);
  });

  if (row.costo.value !== null && row.costo.value < 0) problems.push("El precio de costo no puede ser negativo.");
  if (row.precio_venta.value !== null && row.precio_venta.value < 0) problems.push("El precio de venta no puede ser negativo.");
  if (row.stock_minimo.value !== null && row.stock_minimo.value < 0) problems.push("El stock mínimo no puede ser negativo.");
  if (row.cantidad.value !== null && row.cantidad.value < 0) problems.push("La cantidad a ingresar no puede ser negativa.");

  if (problems.length) {
    row.status = "Error";
    row.statusType = "error";
    row.problem = problems.join(" ");
  }
}

function classifyExcelRow(row) {
  if (row.statusType === "error") return;

  const category = row.categoria ? findCategoryByName(row.categoria) : null;
  const exactProducts = findProductsByName(row.nombre);
  const matchingProducts = exactProducts.filter((product) =>
    matchesOptionalImportMeta(product, row.marca, category?.id)
  );
  const product = matchingProducts[0] || exactProducts[0] || findPossibleDuplicate(row);

  row.category = category;

  if (product) {
    row.product = product;

    if (getProductUnit(product) !== row.unidad_stock) {
      row.status = "Error";
      row.statusType = "error";
      row.problem = `La unidad no coincide con el producto existente, que se maneja por ${unitLabel(getProductUnit(product))}.`;
      return;
    }

    row.status = exactProducts.length ? "Producto existente" : "Posible duplicado";
    row.statusType = exactProducts.length ? "existing" : "duplicate";
    return;
  }

  row.status = "Producto nuevo";
  row.statusType = "new";
}

function markRepeatedExcelProducts(rows) {
  const firstByName = new Map();

  rows.forEach((row) => {
    if (row.statusType !== "new") return;
    const key = normalizeText(row.nombre);
    if (!key) return;

    const previous = firstByName.get(key);
    if (!previous) {
      firstByName.set(key, row);
      return;
    }

    if (previous.unidad_stock !== row.unidad_stock) {
      row.status = "Error";
      row.statusType = "error";
      row.problem = `El mismo producto aparece en la fila ${previous.rowNumber} con otra unidad de stock.`;
      return;
    }

    row.duplicateOfRow = previous.rowNumber;
    row.status = "Posible duplicado";
    row.statusType = "duplicate";
  });
}

function renderExcelPreview() {
  const panel = document.querySelector("#excel-preview");
  const summary = document.querySelector("#excel-summary");
  const errors = document.querySelector("#excel-errors");
  const tbody = document.querySelector("#excel-preview-table");
  if (!panel || !summary || !errors || !tbody) return;

  const rows = state.excelPreviewRows;
  if (!rows.length) {
    panel.classList.add("hidden");
    return;
  }

  const newCount = rows.filter((row) => row.statusType === "new").length;
  const existingWithStock = rows.filter((row) =>
    ["existing", "duplicate"].includes(row.statusType) && row.cantidad.value > 0
  ).length;
  const withoutQuantity = rows.filter((row) => !row.cantidad.value).length;
  const errorRows = rows.filter((row) => row.statusType === "error");

  panel.classList.remove("hidden");
  summary.innerHTML = `
    <span>Productos nuevos: <strong>${newCount}</strong></span>
    <span>Existentes con ingreso: <strong>${existingWithStock}</strong></span>
    <span>Filas sin cantidad: <strong>${withoutQuantity}</strong></span>
    <span>Errores: <strong>${errorRows.length}</strong></span>
  `;

  if (errorRows.length) {
    errors.classList.remove("hidden");
    errors.innerHTML = errorRows
      .map((row) => `<div>Fila ${row.rowNumber} - ${escapeHtml(row.nombre || "Sin nombre")}: ${escapeHtml(row.problem)}</div>`)
      .join("");
  } else {
    errors.classList.add("hidden");
    errors.innerHTML = "";
  }

  tbody.innerHTML = rows.map(renderExcelPreviewRow).join("");
}

function renderExcelPreviewRow(row) {
  return `
    <tr>
      <td>${row.rowNumber}</td>
      <td>${escapeHtml(row.nombre || "-")}</td>
      <td>${escapeHtml(row.categoria || "-")}</td>
      <td>${escapeHtml(row.marca || "-")}</td>
      <td>${escapeHtml(row.unidad_stock ? unitLabel(row.unidad_stock) : "-")}</td>
      <td class="number">${formatOptionalNumber(row.costo.value)}</td>
      <td class="number">${formatOptionalNumber(row.precio_venta.value)}</td>
      <td class="number">${formatOptionalNumber(row.stock_minimo.value)}</td>
      <td class="number">${formatOptionalNumber(row.cantidad.value)}</td>
      <td><span class="status-badge status-${row.statusType}">${escapeHtml(row.status)}</span></td>
    </tr>
  `;
}

async function confirmExcelImport() {
  if (state.isImportingExcel) return;
  clearMessage("#merchandise-message");

  if (!supabaseClient) {
    showMessage("#merchandise-message", "Configurá Supabase antes de importar.", "error");
    return;
  }

  if (!state.excelPreviewRows.length) {
    showMessage("#merchandise-message", "Primero elegí un archivo para importar.", "error");
    return;
  }

  const errorRows = state.excelPreviewRows.filter((row) => row.statusType === "error");
  if (errorRows.length) {
    showMessage("#merchandise-message", "Corregí las filas con error antes de importar.", "error");
    return;
  }

  const deposit = state.ubicaciones.find((item) => item.nombre === DEPOSITO_MINORISTA);
  if (!deposit) {
    showMessage("#merchandise-message", "No se encontró la ubicación Depósito Minorista.", "error");
    return;
  }

  try {
    state.isImportingExcel = true;
    setButtonBusy("#confirm-excel-import", true, "Importando...");

    for (const row of state.excelPreviewRows) {
      const productId = row.product?.id || getImportedProductIdFromPreviousRow(row) || await createProductFromExcelRow(row);
      const quantity = row.cantidad.value || 0;

      if (!row.product || quantity > 0) {
        await updateStockInLocation(productId, deposit.id, quantity);
      }

      if (quantity > 0) {
        await insertStockMovement(productId, deposit.id, "ingreso", quantity);
      }
    }

    await loadInitialData();
    clearExcelPreview();
    showMessage("#merchandise-message", "Importación completada correctamente.", "ok");
    showScreen("stock");
  } catch (error) {
    showMessage("#merchandise-message", error.message, "error");
  } finally {
    state.isImportingExcel = false;
    setButtonBusy("#confirm-excel-import", false);
  }
}

async function createProductFromExcelRow(row) {
  const category = await findOrCreateCategory(row.categoria);
  const brand = await findOrCreateBrand(row.marca);
  const product = await insertProduct({
    nombre: row.nombre,
    categoria_id: category?.id || null,
    marca_id: brand?.id || null,
    unidad_stock: row.unidad_stock,
    costo: row.costo.value,
    precio_venta: row.precio_venta.value,
    stock_minimo: row.stock_minimo.value
  });

  row.product = product;
  return product.id;
}

function getImportedProductIdFromPreviousRow(row) {
  if (!row.duplicateOfRow) return "";
  return state.excelPreviewRows.find(
    (item) => item.rowNumber === row.duplicateOfRow
  )?.product?.id || "";
}

function clearExcelPreview() {
  state.excelPreviewRows = [];
  document.querySelector("#excel-preview")?.classList.add("hidden");
  document.querySelector("#excel-summary").innerHTML = "";
  document.querySelector("#excel-errors").innerHTML = "";
  document.querySelector("#excel-errors")?.classList.add("hidden");
  document.querySelector("#excel-preview-table").innerHTML = "";
  const input = document.querySelector("#excel-import-input");
  if (input) input.value = "";
}

function openNewCategoryPanel() {
  clearMessage("#merchandise-message");
  closeCategoryEditPanel();
  document.querySelector("#new-category-panel")?.classList.remove("hidden");
  const input = document.querySelector("#new-category-name");
  if (input) {
    input.value = "";
    input.focus();
  }
}

function openCategoryEditPanel() {
  clearMessage("#merchandise-message");
  const category = getSelectedNewProductCategory();
  if (!category) return;

  closeNewCategoryPanel();
  document.querySelector("#edit-category-panel")?.classList.remove("hidden");
  const input = document.querySelector("#edit-category-name");
  if (input) {
    input.value = category.nombre;
    input.focus();
    input.select();
  }
}

function closeCategoryPanels() {
  closeNewCategoryPanel();
  closeCategoryEditPanel();
}

function closeNewCategoryPanel() {
  document.querySelector("#new-category-panel")?.classList.add("hidden");
}

function closeCategoryEditPanel() {
  document.querySelector("#edit-category-panel")?.classList.add("hidden");
}

function updateCategoryActionState() {
  const editButton = document.querySelector("#show-edit-category");
  if (!editButton) return;
  editButton.disabled = !document.querySelector("#merchandise-product-category")?.value;
}

async function saveNewCategory() {
  if (state.isCreatingCategory) return;
  clearMessage("#merchandise-message");

  if (!supabaseClient) {
    showMessage("#merchandise-message", "Configurá Supabase antes de guardar categorías.", "error");
    return;
  }

  const name = cleanValue("#new-category-name");
  if (!name) {
    showMessage("#merchandise-message", "Escribí el nombre de la categoría.", "error");
    return;
  }

  if (findCategoryByName(name)) {
    showMessage("#merchandise-message", "Esa categoría ya existe.", "error");
    return;
  }

  try {
    state.isCreatingCategory = true;
    setButtonBusy("#save-new-category", true, "Guardando...");
    const category = await insertCategory(name);
    state.categorias = [...state.categorias, category].sort((a, b) => compareText(a.nombre, b.nombre));
    renderAll();
    document.querySelector("#merchandise-product-category").value = category.id;
    closeNewCategoryPanel();
    updateCategoryActionState();
    showMessage("#merchandise-message", "Categoría creada correctamente.", "ok");
  } catch (error) {
    showMessage("#merchandise-message", error.message, "error");
  } finally {
    state.isCreatingCategory = false;
    setButtonBusy("#save-new-category", false);
  }
}

async function saveCategoryEdit() {
  if (state.isEditingCategory) return;
  clearMessage("#merchandise-message");

  if (!supabaseClient) {
    showMessage("#merchandise-message", "Configurá Supabase antes de editar categorías.", "error");
    return;
  }

  const category = getSelectedNewProductCategory();
  if (!category) {
    showMessage("#merchandise-message", "Elegí una categoría para editar.", "error");
    return;
  }

  const name = cleanValue("#edit-category-name");
  if (!name) {
    showMessage("#merchandise-message", "Escribí el nuevo nombre de la categoría.", "error");
    return;
  }

  const duplicate = findCategoryByName(name);
  if (duplicate && duplicate.id !== category.id) {
    showMessage("#merchandise-message", "Ya existe otra categoría con ese nombre.", "error");
    return;
  }

  if (normalizeText(name) === normalizeText(category.nombre)) {
    closeCategoryEditPanel();
    showMessage("#merchandise-message", "La categoría mantiene el mismo nombre.", "ok");
    return;
  }

  const confirmed = window.confirm(`¿Guardar el cambio de categoría "${category.nombre}" a "${name}"?`);
  if (!confirmed) return;

  try {
    state.isEditingCategory = true;
    setButtonBusy("#save-category-edit", true, "Guardando...");
    const updated = await updateCategoryName(category.id, name);
    applyUpdatedCategory(updated);
    renderAll();
    document.querySelector("#merchandise-product-category").value = updated.id;
    closeCategoryEditPanel();
    updateCategoryActionState();
    showMessage("#merchandise-message", "Categoría editada correctamente.", "ok");
  } catch (error) {
    showMessage("#merchandise-message", error.message, "error");
  } finally {
    state.isEditingCategory = false;
    setButtonBusy("#save-category-edit", false);
  }
}

async function createProductFromMerchandise() {
  const name = cleanValue("#merchandise-product-name");
  const categoryId = document.querySelector("#merchandise-product-category").value;
  const brandName = cleanValue("#merchandise-product-brand");
  const unit = document.querySelector("#merchandise-unit").value;

  if (!name) throw new Error("Completá el nombre del artículo.");
  if (!["unidad", "docena"].includes(unit)) throw new Error("Elegí una unidad de stock válida.");

  const brand = await findOrCreateBrand(brandName);
  const product = await insertProduct({
    nombre: name,
    categoria_id: categoryId || null,
    marca_id: brand?.id || null,
    unidad_stock: unit,
    costo: readNullableNumber("#merchandise-cost"),
    precio_venta: readNullableNumber("#merchandise-price"),
    stock_minimo: readNullableNumber("#merchandise-min-stock")
  });

  return product.id;
}

async function findOrCreateBrand(name) {
  if (!name) return null;

  const existing = state.marcas.find(
    (marca) => normalizeText(marca.nombre) === normalizeText(name)
  );

  if (existing) return existing;

  const { data, error } = await supabaseClient
    .from("marcas")
    .insert({ nombre: name })
    .select()
    .single();

  if (error) throw new Error(error.message);

  state.marcas = [...state.marcas, data].sort((a, b) =>
    a.nombre.localeCompare(b.nombre, "es")
  );

  return data;
}

async function findOrCreateCategory(name) {
  if (!name) return null;

  const existing = state.categorias.find(
    (categoria) => normalizeText(categoria.nombre) === normalizeText(name)
  );

  if (existing) return existing;

  return insertCategory(name);
}

async function insertCategory(name) {
  const { data, error } = await supabaseClient
    .from("categorias")
    .insert({ nombre: name })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function updateCategoryName(id, name) {
  const { data, error } = await supabaseClient
    .from("categorias")
    .update({ nombre: name })
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

function getSelectedNewProductCategory() {
  const categoryId = document.querySelector("#merchandise-product-category")?.value || "";
  if (!categoryId) return null;
  return state.categorias.find((category) => category.id === categoryId) || null;
}

function applyUpdatedCategory(updated) {
  state.categorias = state.categorias
    .map((item) => item.id === updated.id ? { ...item, ...updated } : item)
    .sort((a, b) => compareText(a.nombre, b.nombre));

  state.productos = state.productos.map((product) =>
    product.categoria_id === updated.id
      ? { ...product, categorias: { ...(product.categorias || {}), nombre: updated.nombre } }
      : product
  );

  state.stock = state.stock.map((row) =>
    row.productos?.categoria_id === updated.id
      ? {
          ...row,
          productos: {
            ...row.productos,
            categorias: { ...(row.productos.categorias || {}), nombre: updated.nombre }
          }
        }
      : row
  );
}

function openProductEdit() {
  const product = getSelectedMerchandiseProduct();
  if (!product) return;

  document.querySelector("#edit-product-panel")?.classList.remove("hidden");
  document.querySelector("#edit-product-name").value = product.nombre || "";
  document.querySelector("#edit-product-category").value = product.categoria_id || "";
  document.querySelector("#edit-product-brand").value = product.marcas?.nombre || "";
  document.querySelector("#edit-product-cost").value = product.costo ?? "";
  document.querySelector("#edit-product-price").value = product.precio_venta ?? "";
  document.querySelector("#edit-product-min-stock").value = product.stock_minimo ?? "";
}

function closeProductEdit() {
  document.querySelector("#edit-product-panel")?.classList.add("hidden");
}

async function saveProductEdit() {
  clearMessage("#merchandise-message");

  const product = getSelectedMerchandiseProduct();
  if (!product) {
    showMessage("#merchandise-message", "Elegí un producto existente.", "error");
    return;
  }

  const name = cleanValue("#edit-product-name");
  if (!name) {
    showMessage("#merchandise-message", "Completá el nombre del artículo.", "error");
    return;
  }

  try {
    const brand = await findOrCreateBrand(cleanValue("#edit-product-brand"));
    const { error } = await supabaseClient
      .from("productos")
      .update({
        nombre: name,
        categoria_id: document.querySelector("#edit-product-category").value || null,
        marca_id: brand?.id || null,
        costo: readNullableNumber("#edit-product-cost"),
        precio_venta: readNullableNumber("#edit-product-price"),
        stock_minimo: readNullableNumber("#edit-product-min-stock")
      })
      .eq("id", product.id);

    if (error) throw new Error(error.message);

    await loadInitialData();
    state.selectedMerchandiseProductId = product.id;
    closeProductEdit();
    renderMerchandiseProductSummary();
    showMessage("#merchandise-message", "Producto actualizado correctamente.", "ok");
  } catch (error) {
    showMessage("#merchandise-message", error.message, "error");
  }
}

async function insertProduct(product) {
  const { data, error } = await supabaseClient
    .from("productos")
    .insert(product)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function updateStockInLocation(productId, locationId, quantityChange) {
  const current = state.stock.find(
    (item) => item.producto_id === productId && item.ubicacion_id === locationId
  );

  if (!current) {
    if (quantityChange < 0) {
      throw new Error("No hay stock suficiente para restar esa cantidad.");
    }

    const { data, error } = await supabaseClient
      .from("stock")
      .insert({
        producto_id: productId,
        ubicacion_id: locationId,
        cantidad: quantityChange
      })
      .select("id, producto_id, ubicacion_id, cantidad")
      .single();

    if (error) throw new Error(error.message);
    state.stock = [...state.stock, data];
    return;
  }

  const nextQuantity = Number(current.cantidad) + quantityChange;
  if (nextQuantity < 0) {
    throw new Error("No hay stock suficiente para restar esa cantidad.");
  }

  const { error } = await supabaseClient
    .from("stock")
    .update({ cantidad: nextQuantity })
    .eq("id", current.id);

  if (error) throw new Error(error.message);
  current.cantidad = nextQuantity;
}

async function insertStockMovement(productId, locationId, type, quantity) {
  const { error } = await supabaseClient
    .from("movimientos_stock")
    .insert({
      producto_id: productId,
      ubicacion_id: locationId,
      tipo: type,
      cantidad: quantity,
      observaciones: null
    });

  if (error) throw new Error(error.message);
}

function renderStockTable() {
  const tbody = document.querySelector("#stock-table");
  const cards = document.querySelector("#stock-cards");
  if (!tbody) return;

  const search = normalizeText(document.querySelector("#stock-search")?.value || "");
  const categoryId = document.querySelector("#stock-category-filter")?.value || "";
  const brandId = document.querySelector("#stock-brand-filter")?.value || "";
  const locationId = getDepositoMinoristaId();
  const showInactive = document.querySelector("#stock-show-inactive")?.checked || false;

  const rows = state.stock
    .filter((row) => row.productos && row.ubicaciones)
    .filter((row) => showInactive || row.productos.activo !== false)
    .filter((row) => !categoryId || row.productos.categoria_id === categoryId)
    .filter((row) => !brandId || row.productos.marca_id === brandId)
    .filter((row) => row.ubicacion_id === locationId)
    .filter((row) => matchesWords(row.productos.nombre, search))
    .sort(compareStockRows);

  renderStockSortHeaders();

  if (!locationId) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No se encontró Depósito Minorista.</td></tr>';
    if (cards) cards.innerHTML = '<div class="empty stock-card-empty">No se encontró Depósito Minorista.</div>';
    return;
  }

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No hay stock para mostrar.</td></tr>';
    if (cards) cards.innerHTML = '<div class="empty stock-card-empty">No hay stock para mostrar.</div>';
    return;
  }

  tbody.innerHTML = rows
    .map((row) => {
      const unit = getProductUnit(row.productos);
      return `
        <tr>
          <td>${escapeHtml(row.productos.nombre)}</td>
          <td>${escapeHtml(row.productos.categorias?.nombre || "-")}</td>
          <td>${escapeHtml(row.productos.marcas?.nombre || "-")}</td>
          <td>${escapeHtml(row.ubicaciones.nombre)}</td>
          <td class="number">${formatQuantityWithUnit(row.cantidad, unit)}</td>
        </tr>
      `;
    })
    .join("");

  if (cards) {
    cards.innerHTML = rows.map(renderStockCard).join("");
  }
}

function renderStockCard(row) {
  const product = row.productos;
  const unit = getProductUnit(product);
  const brand = product.marcas?.nombre || "-";
  const category = product.categorias?.nombre || "-";

  return `
    <article class="stock-card">
      <div>
        <h3>${escapeHtml(product.nombre)}</h3>
        <p>${escapeHtml(brand)} · ${escapeHtml(category)}</p>
      </div>
      <strong>Stock: ${escapeHtml(formatQuantityWithUnit(row.cantidad, unit))}</strong>
    </article>
  `;
}

function getDepositoMinoristaId() {
  return state.ubicaciones.find((location) => location.nombre === DEPOSITO_MINORISTA)?.id || "";
}

function setStockSort(field) {
  const current = state.stockSort || DEFAULT_STATE.stockSort;
  state.stockSort = {
    field,
    direction: current.field === field && current.direction === "asc" ? "desc" : "asc"
  };

  renderStockTable();
}

function setStockMobileSort() {
  const value = document.querySelector("#stock-mobile-sort")?.value || "articulo:asc";
  const [field, direction] = value.split(":");
  state.stockSort = {
    field,
    direction
  };

  renderStockTable();
}

function renderStockSortHeaders() {
  const sort = state.stockSort || DEFAULT_STATE.stockSort;
  const mobileSort = document.querySelector("#stock-mobile-sort");

  if (mobileSort && sort.field) {
    mobileSort.value = `${sort.field}:${sort.direction}`;
  }

  document.querySelectorAll("[data-stock-sort]").forEach((button) => {
    const isActive = button.dataset.stockSort === sort.field;
    const arrow = button.querySelector(".sort-arrow");
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-sort", isActive ? (sort.direction === "asc" ? "ascending" : "descending") : "none");
    if (arrow) arrow.textContent = isActive ? (sort.direction === "asc" ? "↑" : "↓") : "";
  });
}

function compareStockRows(a, b) {
  const sort = state.stockSort || DEFAULT_STATE.stockSort;
  const direction = sort.direction === "desc" ? -1 : 1;

  if (!sort.field || sort.field === "articulo") {
    let result = compareText(a.productos.nombre, b.productos.nombre) * direction;
    if (result === 0) result = compareText(a.ubicaciones.nombre, b.ubicaciones.nombre);
    return result;
  } else if (sort.field === "categoria") {
    let result = compareText(a.productos.categorias?.nombre || "", b.productos.categorias?.nombre || "") * direction;
    if (result === 0) result = compareText(a.productos.nombre, b.productos.nombre);
    if (result === 0) result = compareText(a.ubicaciones.nombre, b.ubicaciones.nombre);
    return result;
  } else if (sort.field === "marca") {
    let result = compareText(a.productos.marcas?.nombre || "", b.productos.marcas?.nombre || "") * direction;
    if (result === 0) result = compareText(a.productos.nombre, b.productos.nombre);
    if (result === 0) result = compareText(a.ubicaciones.nombre, b.ubicaciones.nombre);
    return result;
  } else if (sort.field === "ubicacion") {
    let result = compareText(a.ubicaciones.nombre, b.ubicaciones.nombre) * direction;
    if (result === 0) result = compareText(a.productos.nombre, b.productos.nombre);
    return result;
  } else if (sort.field === "stock") {
    let result = (Number(a.cantidad || 0) - Number(b.cantidad || 0)) * direction;
    if (result === 0) result = compareText(a.productos.nombre, b.productos.nombre);
    if (result === 0) result = compareText(a.ubicaciones.nombre, b.ubicaciones.nombre);
    return result;
  }

  return 0;
}

function renderTransferProductOptions() {
  const list = document.querySelector("#transfer-suggestions");
  if (!list) return;

  const search = normalizeText(document.querySelector("#transfer-product-search")?.value || "");
  const categoryId = document.querySelector("#transfer-category-filter")?.value || "";
  const brandId = document.querySelector("#transfer-brand-filter")?.value || "";
  const originId = document.querySelector("#transfer-origin")?.value || "";

  if (!search || state.selectedTransferProductId) {
    list.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  const products = getRankedProducts(search)
    .filter((product) => product.activo !== false)
    .filter((product) => !categoryId || product.categoria_id === categoryId)
    .filter((product) => !brandId || product.marca_id === brandId)
    .map((product) => ({
      ...product,
      available: getAvailableStock(product.id, originId)
    }))
    .filter((product) => originId && product.available > 0)
    .slice(0, 8);

  list.classList.remove("hidden");

  if (!originId) {
    list.innerHTML = '<div class="empty">Elegí un origen para ver stock disponible.</div>';
    return;
  }

  if (!products.length) {
    list.innerHTML = '<div class="empty">No encontré productos con stock disponible en ese origen.</div>';
    return;
  }

  list.innerHTML = products.map(renderTransferSuggestion).join("");
  list.querySelectorAll("[data-select-transfer-product]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTransferProductId = button.dataset.selectTransferProduct;
      renderTransferProductOptions();
      updateTransferAvailable();
      document.querySelector("#transfer-quantity")?.focus();
    });
  });
}

function renderTransferSuggestion(product) {
  const unit = getProductUnit(product);
  const brand = product.marcas?.nombre || "";
  const category = product.categorias?.nombre || "";
  const meta = [
    brand,
    category,
    `Disponible: ${formatQuantityWithUnit(product.available, unit)}`
  ].filter(Boolean).join(" · ");

  return `
    <button class="suggestion-button" type="button" data-select-transfer-product="${product.id}">
      <strong>${escapeHtml(product.nombre)}</strong>
      <span class="suggestion-meta">${escapeHtml(meta)}</span>
    </button>
  `;
}

function updateTransferAvailable() {
  const productId = state.selectedTransferProductId || "";
  const originId = document.querySelector("#transfer-origin")?.value || "";
  const product = state.productos.find((item) => item.id === productId);
  const unit = getProductUnit(product);
  const available = getAvailableStock(productId, originId);
  const summary = document.querySelector("#transfer-product-summary");
  const picker = document.querySelector("#transfer-picker");
  const quantityLabel = document.querySelector("#transfer-quantity-label");

  if (!product) {
    summary?.classList.add("hidden");
    if (summary) summary.innerHTML = "";
    picker?.classList.add("hidden");
    return;
  }

  const brand = product.marcas?.nombre || "";
  const category = product.categorias?.nombre || "";
  summary?.classList.remove("hidden");
  if (summary) {
    summary.innerHTML = `
      <strong>${escapeHtml(product.nombre)}</strong>
      ${brand ? `<span class="transfer-selected-desktop">Marca: ${escapeHtml(brand)}</span>` : ""}
      ${category ? `<span class="transfer-selected-desktop">Categoría: ${escapeHtml(category)}</span>` : ""}
      <span class="transfer-selected-desktop">Stock disponible en origen: ${escapeHtml(formatQuantityWithUnit(available, unit))}</span>
      <span class="unit-pill transfer-selected-desktop">Unidad de stock: ${escapeHtml(unitLabel(unit))}</span>
      <span class="transfer-selected-mobile transfer-selected-meta">${escapeHtml([category, brand].filter(Boolean).join(" · "))}</span>
      <span class="transfer-selected-mobile transfer-selected-available">Disponible: ${escapeHtml(formatQuantityWithUnit(available, unit))}</span>
    `;
  }
  picker?.classList.remove("hidden");
  if (quantityLabel) {
    quantityLabel.textContent = `Cantidad (${unitPlural(unit)})`;
  }
}

function getAvailableStock(productId, locationId) {
  if (!productId || !locationId) return 0;

  const row = state.stock.find(
    (item) => item.producto_id === productId && item.ubicacion_id === locationId
  );

  return Number(row?.cantidad || 0);
}

function addTransferItem() {
  if (state.isAddingTransferItem) return;
  clearMessage("#transfer-message");

  const productId = state.selectedTransferProductId;
  const originId = document.querySelector("#transfer-origin").value;
  const quantity = readNumber("#transfer-quantity", 0);
  const product = state.productos.find((item) => item.id === productId);
  const available = getAvailableStock(productId, originId);

  if (!originId) {
    showMessage("#transfer-message", "Elegí una ubicación de origen.", "error");
    return;
  }

  if (!product) {
    showMessage("#transfer-message", "Elegí un producto.", "error");
    return;
  }

  if (quantity <= 0) {
    showMessage("#transfer-message", "La cantidad debe ser mayor a cero.", "error");
    return;
  }

  if (quantity > available) {
    showMessage("#transfer-message", "La cantidad supera el stock disponible.", "error");
    return;
  }

  const existing = state.transferItems.find((item) => item.producto_id === productId);
  const previousQuantity = existing ? existing.cantidad : 0;

  if (previousQuantity + quantity > available) {
    showMessage("#transfer-message", "La cantidad total supera el stock disponible.", "error");
    return;
  }

  try {
    state.isAddingTransferItem = true;
    setButtonBusy("#add-transfer-item", true, "Agregando...");

    if (existing) {
      existing.cantidad += quantity;
    } else {
      state.transferItems.push({
        producto_id: productId,
        nombre: product.nombre,
        unidad_stock: getProductUnit(product),
        cantidad: quantity
      });
    }

    clearTransferSelection();
    renderTransferItems();
    updateConfirmTransferButton();
    document.querySelector("#transfer-product-search")?.focus();
  } finally {
    state.isAddingTransferItem = false;
    setButtonBusy("#add-transfer-item", false);
  }
}

function renderTransferItems() {
  const tbody = document.querySelector("#transfer-items");
  const cards = document.querySelector("#transfer-items-cards");
  if (!tbody) return;

  if (!state.transferItems.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Agregá productos para transferir.</td></tr>';
    if (cards) cards.innerHTML = '<div class="empty transfer-card-empty">Agregá productos para transferir.</div>';
    updateConfirmTransferButton();
    return;
  }

  tbody.innerHTML = state.transferItems
    .map((item) => `
      <tr>
        <td>${escapeHtml(item.nombre)}</td>
        <td class="number">
          <input class="line-quantity" type="number" min="1" step="1" value="${escapeHtml(item.cantidad)}" aria-label="Cantidad de ${escapeHtml(item.nombre)}" data-transfer-quantity="${item.producto_id}">
        </td>
        <td>${escapeHtml(unitPlural(item.unidad_stock))}</td>
        <td class="number">
          <button class="row-action" type="button" data-remove-product="${item.producto_id}">Quitar</button>
        </td>
      </tr>
    `)
    .join("");

  if (cards) {
    cards.innerHTML = state.transferItems
      .map((item) => `
        <article class="transfer-item-card">
          <div>
            <h3>${escapeHtml(item.nombre)}</h3>
            <strong>${escapeHtml(formatQuantityWithUnit(item.cantidad, item.unidad_stock))}</strong>
          </div>
          <button class="row-action" type="button" data-remove-product="${item.producto_id}">Quitar</button>
        </article>
      `)
      .join("");
  }

  tbody.querySelectorAll("[data-transfer-quantity]").forEach((input) => {
    input.addEventListener("change", () => updateTransferItemQuantity(input));
    input.addEventListener("input", updateConfirmTransferButton);
  });

  document.querySelectorAll("[data-remove-product]").forEach((button) => {
    button.addEventListener("click", () => {
      state.transferItems = state.transferItems.filter(
        (item) => item.producto_id !== button.dataset.removeProduct
      );
      renderTransferItems();
      updateConfirmTransferButton();
    });
  });

  updateConfirmTransferButton();
}

function updateTransferItemQuantity(input) {
  clearMessage("#transfer-message");
  const productId = input.dataset.transferQuantity;
  const item = state.transferItems.find((transferItem) => transferItem.producto_id === productId);
  if (!item) return;

  const originId = document.querySelector("#transfer-origin").value;
  const quantity = Number(input.value || 0);
  const available = getAvailableStock(productId, originId);

  if (quantity <= 0) {
    showMessage("#transfer-message", "La cantidad debe ser mayor a cero.", "error");
    updateConfirmTransferButton();
    return;
  }

  if (quantity > available) {
    input.value = item.cantidad;
    showMessage("#transfer-message", "La cantidad supera el stock disponible.", "error");
    updateConfirmTransferButton();
    return;
  }

  item.cantidad = quantity;
  updateConfirmTransferButton();
}

function clearTransferSelection() {
  state.selectedTransferProductId = null;
  const search = document.querySelector("#transfer-product-search");
  const quantity = document.querySelector("#transfer-quantity");
  if (search) search.value = "";
  if (quantity) quantity.value = "";
  renderTransferProductOptions();
  updateTransferAvailable();
}

function startNewTransfer() {
  state.transferItems = [];
  state.selectedTransferProductId = null;
  state.lastConfirmedTransfer = null;

  clearMessage("#transfer-message");
  hideTransferReceiptActions();
  document.querySelector("#transfer-form")?.reset();
  setDefaultTransferOrigin();

  const dateInput = document.querySelector("#transfer-date");
  if (dateInput) dateInput.valueAsDate = new Date();

  const search = document.querySelector("#transfer-product-search");
  const quantity = document.querySelector("#transfer-quantity");
  if (search) search.value = "";
  if (quantity) quantity.value = "";

  renderTransferProductOptions();
  renderTransferItems();
  updateTransferAvailable();
  updateConfirmTransferButton();
  search?.focus();
}

function updateConfirmTransferButton() {
  const button = document.querySelector("#confirm-transfer");
  if (!button || state.isConfirmingTransfer) return;

  const originId = document.querySelector("#transfer-origin")?.value || "";
  const destinationId = document.querySelector("#transfer-destination")?.value || "";
  const hasValidItems = state.transferItems.length > 0 && state.transferItems.every((item) => {
    const available = getAvailableStock(item.producto_id, originId);
    return Number(item.cantidad || 0) > 0 && Number(item.cantidad || 0) <= available;
  });

  button.disabled = !originId || !destinationId || originId === destinationId || !hasValidItems;
}

async function confirmTransfer() {
  if (state.isConfirmingTransfer) return;
  clearMessage("#transfer-message");
  hideTransferReceiptActions();
  state.lastConfirmedTransfer = null;
  syncTransferItemInputs();

  if (!supabaseClient) {
    showMessage("#transfer-message", "Configurá Supabase antes de transferir.", "error");
    return;
  }

  const originId = document.querySelector("#transfer-origin").value;
  const destinationId = document.querySelector("#transfer-destination").value;
  const date = document.querySelector("#transfer-date").value;

  if (!originId || !destinationId) {
    showMessage("#transfer-message", "Elegí origen y destino.", "error");
    return;
  }

  if (originId === destinationId) {
    showMessage("#transfer-message", "El origen y el destino deben ser distintos.", "error");
    return;
  }

  if (!state.transferItems.length) {
    showMessage("#transfer-message", "Agregá al menos un producto.", "error");
    return;
  }

  const invalidItem = state.transferItems.find((item) => {
    const available = getAvailableStock(item.producto_id, originId);
    return Number(item.cantidad || 0) <= 0 || Number(item.cantidad || 0) > available;
  });

  if (invalidItem) {
    showMessage("#transfer-message", "Revisá las cantidades: no pueden estar vacías ni superar el stock disponible.", "error");
    updateConfirmTransferButton();
    return;
  }

  try {
    state.isConfirmingTransfer = true;
    setButtonBusy("#confirm-transfer", true, "Confirmando...");

    const { data: transferId, error } = await supabaseClient.rpc("transferir_stock", {
      p_origen_id: originId,
      p_destino_id: destinationId,
      p_fecha: date || null,
      p_observaciones: null,
      p_items: state.transferItems.map((item) => ({
        producto_id: item.producto_id,
        cantidad: item.cantidad
      }))
    });

    if (error) throw new Error(error.message);
    const confirmedTransfer = await fetchRemitoById(transferId);

    state.transferItems = [];
    document.querySelector("#transfer-form").reset();
    setDefaultTransferOrigin();
    document.querySelector("#transfer-date").valueAsDate = new Date();
    document.querySelector("#transfer-product-search").value = "";
    document.querySelector("#transfer-quantity").value = "";
    state.selectedTransferProductId = null;

    await loadInitialData();
    state.lastConfirmedTransfer = confirmedTransfer;
    renderTransferItems();
    updateTransferAvailable();
    showMessage("#transfer-message", "Transferencia registrada correctamente.", "ok");
    renderTransferReceiptActions(confirmedTransfer);
  } catch (error) {
    showMessage("#transfer-message", error.message, "error");
  } finally {
    state.isConfirmingTransfer = false;
    setButtonBusy("#confirm-transfer", false);
    updateConfirmTransferButton();
  }
}

function syncTransferItemInputs() {
  document.querySelectorAll("[data-transfer-quantity]").forEach((input) => {
    const item = state.transferItems.find((transferItem) =>
      transferItem.producto_id === input.dataset.transferQuantity
    );
    if (item) item.cantidad = Number(input.value || 0);
  });
}

function renderTransferReceiptActions(remito) {
  const actions = document.querySelector("#transfer-receipt-actions");
  const detail = document.querySelector("#transfer-receipt-detail");
  if (!actions || !detail || !remito) return;

  actions.classList.remove("hidden");
  detail.classList.add("hidden");
  detail.innerHTML = renderReceiptDetail(remito);
}

function hideTransferReceiptActions() {
  document.querySelector("#transfer-receipt-actions")?.classList.add("hidden");
  const detail = document.querySelector("#transfer-receipt-detail");
  if (detail) {
    detail.classList.add("hidden");
    detail.innerHTML = "";
  }
}

function renderRemitos() {
  const tbody = document.querySelector("#remitos-table");
  const cards = document.querySelector("#remito-cards");
  if (!tbody) return;

  const search = normalizeText(document.querySelector("#remito-search")?.value || "");
  const dateFrom = document.querySelector("#remito-date-from")?.value || "";
  const dateTo = document.querySelector("#remito-date-to")?.value || "";

  const remitos = state.remitos
    .filter((remito) => !dateFrom || remito.fecha >= dateFrom)
    .filter((remito) => !dateTo || remito.fecha <= dateTo)
    .filter((remito) => remitoMatchesSearch(remito, search))
    .sort((a, b) => {
      const byDate = String(b.created_at || b.fecha).localeCompare(String(a.created_at || a.fecha));
      if (byDate !== 0) return byDate;
      return compareText(b.numero, a.numero);
    });

  if (!remitos.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No hay remitos para mostrar.</td></tr>';
    if (cards) cards.innerHTML = '<div class="empty remito-card-empty">No hay remitos para mostrar.</div>';
    return;
  }

  tbody.innerHTML = remitos
    .map((remito) => `
      <tr>
        <td>${escapeHtml(remito.numero)}</td>
        <td>${escapeHtml(formatDate(remito.fecha))}</td>
        <td>${escapeHtml(remito.origen)}</td>
        <td>${escapeHtml(remito.destino)}</td>
        <td class="number">${remito.detalles.length}</td>
        <td>
          <div class="table-actions">
            <button class="row-action neutral" data-remito-action="view" data-remito-id="${remito.id}" type="button">Ver comprobante</button>
            <button class="row-action neutral" data-remito-action="pdf" data-remito-id="${remito.id}" type="button">PDF</button>
            <button class="row-action neutral" data-remito-action="whatsapp" data-remito-id="${remito.id}" type="button">WhatsApp</button>
          </div>
        </td>
      </tr>
    `)
    .join("");

  if (cards) {
    cards.innerHTML = remitos.map(renderRemitoCard).join("");
  }

  document.querySelectorAll("[data-remito-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const remito = state.remitos.find((item) => item.id === button.dataset.remitoId);
      handleReceiptAction(button.dataset.remitoAction, remito, "#remito-detail");
    });
  });
}

function renderRemitoCard(remito) {
  return `
    <article class="remito-card" data-remito-card="${remito.id}">
      <button class="remito-card-main" data-remito-action="view" data-remito-id="${remito.id}" type="button">
        <span class="remito-card-top">
          <strong>${escapeHtml(remito.numero)}</strong>
          <span>${escapeHtml(formatDate(remito.fecha))}</span>
        </span>
        <span class="remito-card-route">
          <span>${escapeHtml(remito.origen)}</span>
          <span>→ ${escapeHtml(remito.destino)}</span>
        </span>
        <span class="remito-card-summary">${escapeHtml(remitoSummaryText(remito))}</span>
      </button>
      <div class="remito-card-actions">
        <button class="row-action neutral" data-remito-action="view" data-remito-id="${remito.id}" type="button">Ver remito</button>
        <button class="row-action neutral" data-remito-action="pdf" data-remito-id="${remito.id}" type="button">PDF</button>
        <button class="row-action neutral" data-remito-action="whatsapp" data-remito-id="${remito.id}" type="button">WhatsApp</button>
      </div>
    </article>
  `;
}

function remitoSummaryText(remito) {
  const quantityByUnit = remito.detalles.reduce((summary, detail) => {
    const unit = unitPlural(detail.unidad_stock);
    summary[unit] = (summary[unit] || 0) + Number(detail.cantidad || 0);
    return summary;
  }, {});

  const quantities = Object.entries(quantityByUnit)
    .map(([unit, quantity]) => `${formatQuantity(quantity)} ${unit}`)
    .join(" / ");

  return `${remito.detalles.length} artículos${quantities ? ` · ${quantities}` : ""}`;
}

function remitoMatchesSearch(remito, search) {
  if (!search) return true;

  const fields = [
    remito.numero,
    remito.origen,
    remito.destino,
    ...remito.detalles.map((detail) => detail.articulo)
  ];

  return search
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => fields.some((field) => normalizeText(field).includes(term)));
}

async function handleReceiptAction(action, remito, targetSelector = "#transfer-receipt-detail") {
  if (!remito) return;

  if (action === "view") {
    const detail = document.querySelector(targetSelector);
    if (!detail) return;
    detail.innerHTML = renderReceiptDetail(remito);
    detail.classList.remove("hidden");
    detail.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  if (action === "pdf") {
    downloadReceiptPdf(remito);
    return;
  }

  if (action === "whatsapp") {
    await shareReceiptByWhatsApp(remito);
  }
}

function renderReceiptDetail(remito) {
  return `
    <div class="receipt-paper">
      <h3>Remito de transferencia Nº ${escapeHtml(formatReceiptNumber(remito.numero))}</h3>
      <div class="receipt-meta">
        <span>Fecha: ${escapeHtml(formatDate(remito.fecha))}</span>
        <span>Origen: ${escapeHtml(remito.origen)}</span>
        <span>Destino: ${escapeHtml(remito.destino)}</span>
      </div>
      <div class="table-wrap compact receipt-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Artículo</th>
              <th class="number">Cantidad</th>
              <th>Unidad de stock</th>
            </tr>
          </thead>
          <tbody>
            ${remito.detalles.map((detail) => `
              <tr>
                <td>${escapeHtml(detail.articulo)}</td>
                <td class="number">${escapeHtml(formatQuantity(detail.cantidad))}</td>
                <td>${escapeHtml(unitPlural(detail.unidad_stock))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function downloadReceiptPdf(remito) {
  const pdf = buildReceiptPdf(remito);
  if (!pdf) {
    showMessage("#transfer-message", "No se pudo cargar el generador de PDF. Probá recargar la app.", "error");
    return;
  }

  pdf.save(`${safeFilename(remito.numero)}.pdf`);
}

function buildReceiptPdf(remito) {
  const jsPDF = window.jspdf?.jsPDF;
  if (!jsPDF) return null;

  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const margin = 14;
  let y = 18;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(15);
  pdf.text(`REMITO DE TRANSFERENCIA Nº ${formatReceiptNumber(remito.numero)}`, margin, y);
  y += 12;

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(11);
  pdf.text(`Fecha: ${formatDate(remito.fecha)}`, margin, y);
  y += 7;
  pdf.text(`Origen: ${remito.origen}`, margin, y);
  y += 7;
  pdf.text(`Destino: ${remito.destino}`, margin, y);
  y += 12;

  pdf.setFont("helvetica", "bold");
  pdf.text("ARTÍCULO", margin, y);
  pdf.text("CANTIDAD", 145, y, { align: "right" });
  pdf.text("UNIDAD DE STOCK", 158, y);
  y += 3;
  pdf.line(margin, y, 196, y);
  y += 7;

  pdf.setFont("helvetica", "normal");
  remito.detalles.forEach((detail) => {
    if (y > 280) {
      pdf.addPage();
      y = 18;
    }

    const lines = pdf.splitTextToSize(detail.articulo, 110);
    pdf.text(lines, margin, y);
    pdf.text(formatQuantity(detail.cantidad), 145, y, { align: "right" });
    pdf.text(unitPlural(detail.unidad_stock), 158, y);
    y += Math.max(7, lines.length * 5);
  });

  return pdf;
}

async function shareReceiptByWhatsApp(remito) {
  const text = receiptShareText(remito);
  const pdf = buildReceiptPdf(remito);

  if (pdf && navigator.canShare && navigator.share && window.File) {
    const file = new File(
      [pdf.output("blob")],
      `${safeFilename(remito.numero)}.pdf`,
      { type: "application/pdf" }
    );

    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title: `Remito ${remito.numero}`, text, files: [file] });
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }
  }

  if (pdf) pdf.save(`${safeFilename(remito.numero)}.pdf`);
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
}

function receiptShareText(remito) {
  return [
    `Remito de transferencia ${formatReceiptNumber(remito.numero)}`,
    `Fecha: ${formatDate(remito.fecha)}`,
    `Origen: ${remito.origen}`,
    `Destino: ${remito.destino}`
  ].join("\n");
}

function formatReceiptNumber(numero) {
  const digits = String(numero || "").match(/\d+/g)?.join("") || "";
  return digits ? digits.padStart(6, "0") : String(numero || "");
}

function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = String(value).split("-");
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function safeFilename(value) {
  return String(value || "remito")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-");
}

function getSelectedMerchandiseProduct() {
  return state.productos.find((product) => product.id === state.selectedMerchandiseProductId) || null;
}

function getStockOperation() {
  return document.querySelector('input[name="stock-operation"]:checked')?.value || "add";
}

function updateStockOperationButton() {
  const button = document.querySelector("#confirm-stock-operation");
  if (!button) return;
  if (button.disabled) return;

  const isSubtract = getStockOperation() === "subtract";
  const isMobile = window.matchMedia("(max-width: 820px)").matches;
  button.textContent = isMobile
    ? (isSubtract ? "Quitar" : "Agregar")
    : (isSubtract ? "Confirmar resta" : "Confirmar ingreso");
}

function setButtonBusy(selector, isBusy, busyText) {
  const button = document.querySelector(selector);
  if (!button) return;

  if (isBusy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
    return;
  }

  button.disabled = false;
  if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
    delete button.dataset.originalText;
  }

  if (selector === "#confirm-stock-operation") {
    updateStockOperationButton();
  }
}

function getProductUnit(product) {
  return product?.unidad_stock || DEFAULT_UNIT;
}

function getRankedProducts(normalizedSearch) {
  const products = state.productos
    .map((product) => ({
      product,
      score: productSearchScore(product, normalizedSearch)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.product.nombre.localeCompare(b.product.nombre, "es");
    })
    .map((item) => item.product);

  if (normalizedSearch) return products;

  return state.productos
    .slice()
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

function productSearchScore(product, normalizedSearch) {
  if (!normalizedSearch) return 1;

  const fields = [
    { text: product.nombre, weight: 12 },
    { text: product.marcas?.nombre, weight: 8 },
    { text: product.categorias?.nombre, weight: 5 }
  ];

  return normalizedSearch
    .split(/\s+/)
    .filter(Boolean)
    .reduce((total, term) => {
      const best = fields.reduce((fieldBest, field) => {
        const text = normalizeText(field.text);
        if (!text) return fieldBest;

        if (text === term) return Math.max(fieldBest, field.weight + 16);
        if (text.startsWith(term)) return Math.max(fieldBest, field.weight + 12);
        if (text.includes(term)) return Math.max(fieldBest, field.weight + 8);
        if (isOrderedSubsequence(term, text)) {
          return Math.max(fieldBest, field.weight + Math.max(2, 8 - text.length + term.length));
        }

        const tokenScore = text
          .split(/\s+/)
          .filter(Boolean)
          .reduce((bestToken, token) => {
            if (token.startsWith(term) || term.startsWith(token)) {
              return Math.max(bestToken, field.weight + 6);
            }

            if (isOrderedSubsequence(term, token)) {
              return Math.max(bestToken, field.weight + Math.max(2, 7 - token.length + term.length));
            }

            const distance = levenshteinDistance(term, token);
            const limit = term.length <= 4 ? 1 : 2;
            if (distance <= limit) {
              return Math.max(bestToken, field.weight + 4 - distance);
            }

            return bestToken;
          }, 0);

        return Math.max(fieldBest, tokenScore);
      }, 0);

      return best === 0 ? 0 : total + best;
    }, 0);
}

function isOrderedSubsequence(needle, haystack) {
  if (!needle) return true;
  let index = 0;

  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }

  return false;
}

function unitLabel(unit) {
  return unit === "docena" ? "Docena" : "Unidad";
}

function unitPlural(unit) {
  return unit === "docena" ? "docenas" : "unidades";
}

function formatQuantityWithUnit(value, unit) {
  return `${formatQuantity(value)} ${unitPlural(unit)}`;
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""), "es", {
    sensitivity: "base",
    numeric: true
  });
}

function getExcelHeaders() {
  return [
    "Nombre del artículo",
    "Categoría",
    "Marca",
    "Unidad de stock",
    "Precio de costo",
    "Precio de venta",
    "Stock mínimo",
    "Cantidad a ingresar"
  ];
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function normalizeColumnName(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function normalizeUnit(value) {
  const normalized = normalizeText(value);
  if (["unidad", "unidades", "u"].includes(normalized)) return "unidad";
  if (["docena", "docenas", "d"].includes(normalized)) return "docena";
  return "";
}

function parseExcelNumber(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null, error: "" };

  let normalized = raw.replace(/\$/g, "").replace(/\s/g, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = normalized.replace(",", ".");
  }

  const number = Number(normalized);
  if (!Number.isFinite(number)) {
    return { value: null, error: `${label} debe ser numérico.` };
  }

  return { value: number, error: "" };
}

function formatOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return "-";
  return formatQuantity(value);
}

function findCategoryByName(name) {
  const normalized = normalizeText(name);
  return state.categorias.find((category) => normalizeText(category.nombre) === normalized) || null;
}

function findProductsByName(name) {
  const normalized = normalizeText(name);
  return state.productos.filter((product) => normalizeText(product.nombre) === normalized);
}

function matchesOptionalImportMeta(product, brandName, categoryId) {
  const brandMatches = !brandName || normalizeText(product.marcas?.nombre) === normalizeText(brandName);
  const categoryMatches = !categoryId || product.categoria_id === categoryId;
  return brandMatches && categoryMatches;
}

function findPossibleDuplicate(row) {
  const normalizedName = normalizeText(row.nombre);
  if (!normalizedName) return null;

  const ranked = state.productos
    .map((product) => {
      const nameScore = possibleDuplicateNameScore(normalizedName, normalizeText(product.nombre));
      const brandScore = row.marca && normalizeText(product.marcas?.nombre) === normalizeText(row.marca) ? 6 : 0;
      const categoryScore = row.category && product.categoria_id === row.category.id ? 4 : 0;
      return { product, score: nameScore + brandScore + categoryScore };
    })
    .filter((item) => item.score >= 16)
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.product || null;
}

function possibleDuplicateNameScore(sourceName, candidateName) {
  if (!sourceName || !candidateName) return 0;
  if (sourceName === candidateName) return 30;
  if (sourceName.length >= 6 && candidateName.includes(sourceName)) return 24;
  if (candidateName.length >= 6 && sourceName.includes(candidateName)) return 24;

  const distance = levenshteinDistance(sourceName, candidateName);
  if (distance <= 2) return 22 - distance;

  const sourceTokens = sourceName.split(/\s+/).filter((token) => token.length >= 3);
  const candidateTokens = candidateName.split(/\s+/).filter(Boolean);
  if (!sourceTokens.length) return 0;

  const matchedTokens = sourceTokens.filter((token) =>
    candidateTokens.some((candidateToken) => {
      if (token === candidateToken) return true;
      if (token.length >= 5 && (token.startsWith(candidateToken) || candidateToken.startsWith(token))) return true;
      return levenshteinDistance(token, candidateToken) <= (token.length <= 4 ? 1 : 2);
    })
  );

  return matchedTokens.length === sourceTokens.length ? 16 : 0;
}

function cleanValue(selector) {
  return document.querySelector(selector).value.trim();
}

function readNumber(selector, fallback) {
  const value = document.querySelector(selector).value;
  if (value === "") return fallback;
  return Number(value);
}

function readNullableNumber(selector) {
  const value = document.querySelector(selector).value;
  return value === "" ? null : Number(value);
}

function matchesWords(text, normalizedSearch) {
  if (!normalizedSearch) return true;
  const normalizedText = normalizeText(text);
  return normalizedSearch
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => normalizedText.includes(word));
}

function levenshteinDistance(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function formatQuantity(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

function showMessage(selector, text, type) {
  const element = document.querySelector(selector);
  if (!element) return;

  element.textContent = text;
  element.className = `message visible ${type}`;
}

function clearMessage(selector) {
  const element = document.querySelector(selector);
  if (!element) return;

  element.textContent = "";
  element.className = "message";
}

function setConnectionError(message) {
  const status = document.querySelector("#connection-status");
  status.textContent = `Error: ${message}`;
  status.className = "connection error";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

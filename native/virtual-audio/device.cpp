// SPDX-License-Identifier: MIT
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <setupapi.h>
#include <newdev.h>
#include <devguid.h>
#include <cfgmgr32.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <devicetopology.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wintrust.h>
#include <softpub.h>
#include <wincrypt.h>
#include <shlobj.h>
#include <wrl/client.h>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>
#include <algorithm>
#include "vendor-pins.h"
using Microsoft::WRL::ComPtr;
static constexpr wchar_t HardwareId[] = L"VBAudioVACWDM";
static constexpr wchar_t OwnerKey[] = L"SOFTWARE\\DDTrans\\VirtualAudio";
static constexpr wchar_t AliasTask[] = L"DDTrans-VirtualAudio-Configure";
static constexpr PROPERTYKEY NeverDefault = {{0xf3e80bef, 0x1723, 0x4ff2, {0xbc, 0xc4, 0x7f, 0x83, 0xdc, 0x5e, 0x46, 0xd4}}, 3};
struct Adapter { std::wstring id; ULONG problem = 0; };
struct Endpoint { std::wstring id, name, description, adapterId, connectorId, association; EDataFlow flow = eRender; DWORD state = 0; bool main = false; };

static void require(bool condition, DWORD error, const char* operation) {
    if (!condition) { std::fprintf(stderr, "%s failed (Windows %lu).\n", operation, error); throw error; }
}
static void win32(BOOL success, const char* operation) { if (!success) require(false, GetLastError(), operation); }
static void check(HRESULT result, const char* operation) { require(SUCCEEDED(result), static_cast<DWORD>(result), operation); }
static std::string utf8(const std::wstring& text) {
    if (text.empty()) return {};
    const int count = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<size_t>(count), 0);
    WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), result.data(), count, nullptr, nullptr);
    return result;
}
static void quoted(const std::wstring& text) {
    std::putchar('"');
    for (unsigned char c : utf8(text)) { if (c == '"' || c == '\\') std::putchar('\\'); if (c < 32) std::printf("\\u%04x", c); else std::putchar(c); }
    std::putchar('"');
}
static bool equal(const std::wstring& one, const std::wstring& two) { return _wcsicmp(one.c_str(), two.c_str()) == 0; }
static bool vendorDevice(HDEVINFO devices, SP_DEVINFO_DATA& device) {
    wchar_t ids[4096] = {}; DWORD type = 0;
    if (!SetupDiGetDeviceRegistryPropertyW(devices, &device, SPDRP_HARDWAREID, &type, reinterpret_cast<BYTE*>(ids), sizeof(ids), nullptr) || type != REG_MULTI_SZ) return false;
    for (const wchar_t* id = ids; *id; id += wcslen(id) + 1) if (_wcsicmp(id, HardwareId) == 0) return true;
    return false;
}
static std::vector<Adapter> adapters(bool presentOnly = true) {
    HDEVINFO devices = SetupDiGetClassDevsW(&GUID_DEVCLASS_MEDIA, nullptr, nullptr, presentOnly ? DIGCF_PRESENT : 0);
    require(devices != INVALID_HANDLE_VALUE, GetLastError(), "Enumerate audio adapters");
    std::vector<Adapter> result;
    SP_DEVINFO_DATA device = {}; device.cbSize = sizeof(device);
    for (DWORD index = 0; SetupDiEnumDeviceInfo(devices, index, &device); ++index) {
        if (!vendorDevice(devices, device)) continue;
        wchar_t id[MAX_DEVICE_ID_LEN] = {};
        if (!SetupDiGetDeviceInstanceIdW(devices, &device, id, MAX_DEVICE_ID_LEN, nullptr)) continue;
        ULONG state = 0, problem = 0;
        if (CM_Get_DevNode_Status(&state, &problem, device.DevInst, 0) != CR_SUCCESS) problem = CM_PROB_NOT_CONFIGURED;
        result.push_back({id, problem});
    }
    SetupDiDestroyDeviceInfoList(devices);
    return result;
}
static std::wstring property(IPropertyStore* properties, REFPROPERTYKEY key) {
    PROPVARIANT value; PropVariantInit(&value); std::wstring result;
    if (SUCCEEDED(properties->GetValue(key, &value)) && value.vt == VT_LPWSTR && value.pwszVal) result = value.pwszVal;
    PropVariantClear(&value); return result;
}
static std::wstring adapterAncestor(const std::wstring& instance, const std::vector<Adapter>& known) {
    if (instance.empty()) return {};
    DEVINST node = 0;
    if (CM_Locate_DevNodeW(&node, const_cast<wchar_t*>(instance.c_str()), CM_LOCATE_DEVNODE_NORMAL) != CR_SUCCESS) return {};
    for (unsigned depth = 0; depth < 16; ++depth) {
        wchar_t id[MAX_DEVICE_ID_LEN] = {};
        if (CM_Get_Device_IDW(node, id, MAX_DEVICE_ID_LEN, 0) != CR_SUCCESS) break;
        for (const auto& adapter : known) if (equal(id, adapter.id)) return adapter.id;
        DEVINST parent = 0;
        if (CM_Get_Parent(&parent, node, 0) != CR_SUCCESS || parent == node) break;
        node = parent;
    }
    return {};
}
static std::wstring endpointAdapter(IMMDeviceEnumerator* enumerator, IMMDevice* device, IPropertyStore* properties, const std::vector<Adapter>& known, std::wstring* connectorId) {
    auto result = adapterAncestor(property(properties, PKEY_Device_InstanceId), known);
    ComPtr<IDeviceTopology> topology;
    if (FAILED(device->Activate(__uuidof(IDeviceTopology), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(topology.GetAddressOf())))) return result;
    ComPtr<IConnector> connector;
    if (FAILED(topology->GetConnector(0, connector.GetAddressOf()))) return result;
    LPWSTR connectedConnector = nullptr;
    if (SUCCEEDED(connector->GetConnectorIdConnectedTo(&connectedConnector))) { *connectorId = connectedConnector; CoTaskMemFree(connectedConnector); }
    if (!result.empty()) return result;
    LPWSTR connectedId = nullptr;
    if (FAILED(connector->GetDeviceIdConnectedTo(&connectedId))) return {};
    ComPtr<IMMDevice> connected;
    const HRESULT found = enumerator->GetDevice(connectedId, connected.GetAddressOf()); CoTaskMemFree(connectedId);
    if (FAILED(found)) return {};
    ComPtr<IPropertyStore> connectedProperties;
    if (FAILED(connected->OpenPropertyStore(STGM_READ, connectedProperties.GetAddressOf()))) return {};
    return adapterAncestor(property(connectedProperties.Get(), PKEY_Device_InstanceId), known);
}
static bool endsWith(const std::wstring& text, const std::wstring& suffix) { return text.size() >= suffix.size() && _wcsicmp(text.c_str() + text.size() - suffix.size(), suffix.c_str()) == 0; }
static bool named(const std::wstring& text, const wchar_t* base) {
    return equal(text, base) || equal(text, std::wstring(base) + L" (VB-Audio Virtual Cable)");
}
static std::vector<Endpoint> endpoints(IMMDeviceEnumerator* enumerator, const std::vector<Adapter>& known) {
    std::vector<Endpoint> result;
    for (const EDataFlow flow : {eRender, eCapture}) {
        ComPtr<IMMDeviceCollection> collection;
        check(enumerator->EnumAudioEndpoints(flow, DEVICE_STATEMASK_ALL, collection.GetAddressOf()), "Enumerate endpoints");
        UINT count = 0; check(collection->GetCount(&count), "Count endpoints");
        for (UINT index = 0; index < count; ++index) {
            ComPtr<IMMDevice> device; ComPtr<IPropertyStore> properties;
            if (FAILED(collection->Item(index, device.GetAddressOf())) || FAILED(device->OpenPropertyStore(STGM_READ, properties.GetAddressOf()))) continue;
            std::wstring connectorId;
            auto adapterId = endpointAdapter(enumerator, device.Get(), properties.Get(), known, &connectorId);
            if (adapterId.empty()) continue;
            LPWSTR id = nullptr; if (FAILED(device->GetId(&id))) continue;
            Endpoint value; value.id = id; CoTaskMemFree(id);
            value.adapterId = adapterId; value.flow = flow; device->GetState(&value.state);
            value.name = property(properties.Get(), PKEY_Device_FriendlyName);
            value.description = property(properties.Get(), PKEY_Device_DeviceDesc);
            value.connectorId = connectorId; value.association = property(properties.Get(), PKEY_AudioEndpoint_Association);
            const wchar_t* original = flow == eRender ? L"CABLE Input" : L"CABLE Output";
            const wchar_t* alias = flow == eRender ? L"DDTrans Virtual Input" : L"DDTrans Virtual Microphone";
            value.main = endsWith(value.connectorId, flow == eRender ? DDTRANS_VENDOR_RENDER_CONNECTOR : DDTRANS_VENDOR_CAPTURE_CONNECTOR) || named(value.name, original) || named(value.description, original) || named(value.name, alias) || named(value.description, alias);
            result.push_back(value);
        }
    }
    return result;
}
static std::wstring ownedInstance() {
    wchar_t value[MAX_DEVICE_ID_LEN] = {}; DWORD bytes = sizeof(value);
    if (RegGetValueW(HKEY_LOCAL_MACHINE, OwnerKey, L"DeviceInstanceId", RRF_RT_REG_SZ, nullptr, value, &bytes) != ERROR_SUCCESS) return {};
    return value;
}
static bool owns(const std::vector<Adapter>& known) {
    return known.size() == 1 && equal(known[0].id, ownedInstance());
}
static void rememberOwner(const std::wstring& instance) {
    HKEY key = nullptr;
    const LSTATUS opened = RegCreateKeyExW(HKEY_LOCAL_MACHINE, OwnerKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr);
    require(opened == ERROR_SUCCESS, opened, "Create DDTrans device ownership record");
    const LSTATUS written = RegSetValueExW(key, L"DeviceInstanceId", 0, REG_SZ, reinterpret_cast<const BYTE*>(instance.c_str()), static_cast<DWORD>((instance.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(key); require(written == ERROR_SUCCESS, written, "Write DDTrans device ownership record");
}
static bool admin() {
    SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY; PSID group = nullptr; BOOL member = FALSE;
    if (AllocateAndInitializeSid(&authority, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0, &group)) { CheckTokenMembership(nullptr, group, &member); FreeSid(group); }
    return member == TRUE;
}
static DWORD status(IMMDeviceEnumerator* enumerator) {
    const auto known = adapters(); const auto audio = endpoints(enumerator, known);
    std::printf("{\"provider\":\"VB-Audio Software\",\"adapters\":["); bool comma = false;
    for (const auto& item : known) { if (comma) std::putchar(','); comma = true; std::printf("{\"id\":"); quoted(item.id); std::printf(",\"problemCode\":%lu}", item.problem); }
    std::printf("],\"endpoints\":["); comma = false; unsigned renders = 0, captures = 0;
    for (const auto& item : audio) {
        if (comma) std::putchar(','); comma = true;
        std::printf("{\"id\":"); quoted(item.id); std::printf(",\"name\":"); quoted(item.name); std::printf(",\"adapterId\":"); quoted(item.adapterId);
        std::printf(",\"description\":"); quoted(item.description); std::printf(",\"connectorId\":"); quoted(item.connectorId); std::printf(",\"association\":"); quoted(item.association);
        std::printf(",\"flow\":\"%s\",\"state\":%lu,\"mainEndpoint\":%s}", item.flow == eRender ? "render" : "capture", item.state, item.main ? "true" : "false");
        if (item.main && item.state == DEVICE_STATE_ACTIVE) { if (item.flow == eRender) ++renders; else ++captures; }
    }
    std::printf("],\"defaultDevices\":["); comma = false;
    for (const EDataFlow flow : {eRender, eCapture}) for (const ERole role : {eConsole, eMultimedia, eCommunications}) {
        ComPtr<IMMDevice> device; ComPtr<IPropertyStore> properties;
        if (FAILED(enumerator->GetDefaultAudioEndpoint(flow, role, device.GetAddressOf())) || FAILED(device->OpenPropertyStore(STGM_READ, properties.GetAddressOf()))) continue;
        if (comma) std::putchar(','); comma = true;
        std::printf("{\"flow\":\"%s\",\"role\":%d,\"name\":", flow == eRender ? "render" : "capture", static_cast<int>(role)); quoted(property(properties.Get(), PKEY_Device_FriendlyName)); std::putchar('}');
    }
    std::printf("],\"ready\":%s,\"activeRenderCount\":%u,\"activeCaptureCount\":%u,\"ownedByDDTrans\":%s,\"administrator\":%s}\n", known.size() == 1 && known[0].problem == 0 && renders == 1 && captures == 1 ? "true" : "false", renders, captures, owns(known) ? "true" : "false", admin() ? "true" : "false");
    return ERROR_SUCCESS;
}
static std::wstring sha256(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(file != INVALID_HANDLE_VALUE, GetLastError(), "Open pinned driver payload");
    HCRYPTPROV provider = 0; HCRYPTHASH hash = 0;
    if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) || !CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)) {
        const DWORD error = GetLastError(); CloseHandle(file); if (provider) CryptReleaseContext(provider, 0); require(false, error, "Create SHA-256 hash");
    }
    BYTE buffer[32768]; DWORD read = 0; bool ok = true;
    for (;;) { if (!ReadFile(file, buffer, sizeof(buffer), &read, nullptr)) { ok = false; break; } if (!read) break; if (!CryptHashData(hash, buffer, read, 0)) { ok = false; break; } }
    BYTE digest[32]; DWORD length = sizeof(digest);
    ok = ok && CryptGetHashParam(hash, HP_HASHVAL, digest, &length, 0) && length == sizeof(digest);
    CryptDestroyHash(hash); CryptReleaseContext(provider, 0); CloseHandle(file);
    require(ok, ERROR_CRC, "Hash pinned driver payload");
    std::wstring result; const wchar_t digits[] = L"0123456789ABCDEF";
    for (BYTE value : digest) { result.push_back(digits[value >> 4]); result.push_back(digits[value & 15]); }
    return result;
}
static void verifyPackage(const std::wstring& directory) {
    const std::pair<const wchar_t*, const wchar_t*> files[] = {
        {L"vbMmeCable64_win10.inf", DDTRANS_VENDOR_INF_HASH}, {L"vbaudio_cable64_win10.cat", DDTRANS_VENDOR_CAT_HASH}, {L"vbaudio_cable64_win10.sys", DDTRANS_VENDOR_SYS_HASH}
    };
    for (const auto& item : files) require(sha256(directory + L"\\" + item.first) == item.second, ERROR_CRC, "Verify pinned VB-CABLE file");
    const std::wstring catalog = directory + L"\\vbaudio_cable64_win10.cat";
    WINTRUST_FILE_INFO file = {}; file.cbStruct = sizeof(file); file.pcwszFilePath = catalog.c_str();
    WINTRUST_DATA trust = {}; trust.cbStruct = sizeof(trust); trust.dwUIChoice = WTD_UI_NONE; trust.fdwRevocationChecks = WTD_REVOKE_NONE;
    trust.dwUnionChoice = WTD_CHOICE_FILE; trust.pFile = &file; trust.dwStateAction = WTD_STATEACTION_VERIFY; trust.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL;
    GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    const LONG result = WinVerifyTrust(nullptr, &policy, &trust); trust.dwStateAction = WTD_STATEACTION_CLOSE; WinVerifyTrust(nullptr, &policy, &trust);
    require(result == ERROR_SUCCESS, static_cast<DWORD>(result), "Verify original signed VB-CABLE catalog");
}
static bool endpointResult(HRESULT result, const Endpoint& endpoint, const char* operation) {
    if (SUCCEEDED(result)) return true;
    std::fprintf(stderr, "%s for %s failed (HRESULT 0x%08lX).\n", operation, utf8(endpoint.id).c_str(), static_cast<unsigned long>(result));
    return false;
}
static bool setAlias(IMMDeviceEnumerator* enumerator, const Endpoint& endpoint) {
    const std::wstring alias = endpoint.flow == eRender ? L"DDTrans Virtual Input" : L"DDTrans Virtual Microphone";
    const std::wstring full = alias + L" (VB-Audio Virtual Cable)";
    if (endpoint.name == full && endpoint.description == alias) return true;
    ComPtr<IMMDevice> device; ComPtr<IPropertyStore> properties;
    if (!endpointResult(enumerator->GetDevice(endpoint.id.c_str(), device.GetAddressOf()), endpoint, "Open endpoint") ||
        !endpointResult(device->OpenPropertyStore(STGM_READWRITE, properties.GetAddressOf()), endpoint, "Open endpoint properties")) return false;
    PROPVARIANT description; PropVariantInit(&description); description.vt = VT_LPWSTR; description.pwszVal = const_cast<wchar_t*>(alias.c_str());
    PROPVARIANT friendly; PropVariantInit(&friendly); friendly.vt = VT_LPWSTR; friendly.pwszVal = const_cast<wchar_t*>(full.c_str());
    if (property(properties.Get(), PKEY_Device_DeviceDesc) != alias && !endpointResult(properties->SetValue(PKEY_Device_DeviceDesc, description), endpoint, "Set endpoint description")) return false;
    if (property(properties.Get(), PKEY_Device_FriendlyName) != full && !endpointResult(properties->SetValue(PKEY_Device_FriendlyName, friendly), endpoint, "Set endpoint name")) return false;
    return endpointResult(properties->Commit(), endpoint, "Commit endpoint name");
}
static bool protectRenderDefaults(IMMDeviceEnumerator* enumerator, const std::vector<Endpoint>& audio) {
    for (const auto& endpoint : audio) {
        if (endpoint.flow != eRender || endpoint.state != DEVICE_STATE_ACTIVE) continue;
        ComPtr<IMMDevice> device; ComPtr<IPropertyStore> properties;
        if (!endpointResult(enumerator->GetDevice(endpoint.id.c_str(), device.GetAddressOf()), endpoint, "Open playback endpoint") ||
            !endpointResult(device->OpenPropertyStore(STGM_READWRITE, properties.GetAddressOf()), endpoint, "Open playback policy")) return false;
        PROPVARIANT current; PropVariantInit(&current);
        const bool protectedAlready = SUCCEEDED(properties->GetValue(NeverDefault, &current)) && current.vt == VT_UI4 && current.ulVal == 0x107;
        PropVariantClear(&current);
        if (protectedAlready) continue;
        PROPVARIANT mask; PropVariantInit(&mask); mask.vt = VT_UI4; mask.ulVal = 0x107;
        if (!endpointResult(properties->SetValue(NeverDefault, mask), endpoint, "Protect default playback device") ||
            !endpointResult(properties->Commit(), endpoint, "Commit playback policy")) return false;
    }
    return true;
}
static bool configureAliases(IMMDeviceEnumerator* enumerator, const std::vector<Adapter>& known) {
    if (!owns(known)) return false;
    const auto audio = endpoints(enumerator, known);
    std::vector<Endpoint> main;
    for (const auto& item : audio) if (item.main && item.state == DEVICE_STATE_ACTIVE && equal(item.adapterId, known[0].id)) main.push_back(item);
    if (main.size() != 2 || main[0].flow == main[1].flow || !protectRenderDefaults(enumerator, audio)) return false;
    for (const auto& item : main) if (!setAlias(enumerator, item)) return false;
    return true;
}
static std::wstring argument(const std::wstring& input) {
    std::wstring result = L"\""; unsigned slashes = 0;
    for (wchar_t value : input) {
        if (value == L'\\') { ++slashes; continue; }
        if (value == L'"') { result.append(slashes * 2 + 1, L'\\'); result.push_back(value); }
        else { result.append(slashes, L'\\'); result.push_back(value); }
        slashes = 0;
    }
    result.append(slashes * 2, L'\\'); result.push_back(L'"'); return result;
}
static DWORD schedule(const std::vector<std::wstring>& args) {
    wchar_t system[MAX_PATH]; require(GetSystemDirectoryW(system, MAX_PATH) != 0, GetLastError(), "Locate Windows tools");
    const std::wstring exe = std::wstring(system) + L"\\schtasks.exe";
    std::wstring command = argument(exe); for (const auto& arg : args) command += L" " + argument(arg);
    STARTUPINFOW startup = {}; startup.cb = sizeof(startup); PROCESS_INFORMATION process = {};
    win32(CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process), "Configure post-restart device naming");
    CloseHandle(process.hThread); const DWORD waited = WaitForSingleObject(process.hProcess, 20000); DWORD exitCode = ERROR_TIMEOUT;
    if (waited == WAIT_OBJECT_0) GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hProcess); return exitCode;
}
static DWORD cleanupTask() {
    require(admin(), ERROR_ELEVATION_REQUIRED, "Administrator approval");
    DWORD pending = 0, size = sizeof(pending);
    if (RegGetValueW(HKEY_LOCAL_MACHINE, OwnerKey, L"AliasTaskPending", RRF_RT_REG_DWORD, nullptr, &pending, &size) != ERROR_SUCCESS || !pending) return ERROR_SUCCESS;
    const DWORD result = schedule({L"/Delete", L"/TN", AliasTask, L"/F"});
    if (result == ERROR_SUCCESS) { pending = 0; RegSetKeyValueW(HKEY_LOCAL_MACHINE, OwnerKey, L"AliasTaskPending", REG_DWORD, &pending, sizeof(pending)); }
    return result;
}
static void deferAliases() {
    wchar_t module[32768]; const DWORD length = GetModuleFileNameW(nullptr, module, 32768);
    require(length && length < 32768, ERROR_BAD_PATHNAME, "Locate installed device helper");
    wchar_t programFiles[MAX_PATH]; check(SHGetFolderPathW(nullptr, CSIDL_PROGRAM_FILES, nullptr, SHGFP_TYPE_CURRENT, programFiles), "Locate Program Files");
    const std::wstring prefix = std::wstring(programFiles) + L"\\";
    require(_wcsnicmp(module, prefix.c_str(), prefix.size()) == 0, ERROR_ACCESS_DENIED, "Post-restart helper must be installed under Program Files");
    require(schedule({L"/Create", L"/TN", AliasTask, L"/SC", L"ONLOGON", L"/RU", L"SYSTEM", L"/RL", L"HIGHEST", L"/TR", argument(module) + L" configure", L"/F"}) == ERROR_SUCCESS, ERROR_INSTALL_FAILURE, "Register post-restart device naming");
    const DWORD pending = 1; const LSTATUS saved = RegSetKeyValueW(HKEY_LOCAL_MACHINE, OwnerKey, L"AliasTaskPending", REG_DWORD, &pending, sizeof(pending));
    require(saved == ERROR_SUCCESS, saved, "Record post-restart naming task");
}
static DWORD configure(IMMDeviceEnumerator* enumerator) {
    require(admin(), ERROR_ELEVATION_REQUIRED, "Administrator approval");
    for (unsigned attempt = 0; attempt < 80; ++attempt) {
        const auto known = adapters();
        if (!owns(known)) return ERROR_NOT_OWNER;
        if (configureAliases(enumerator, known)) { const DWORD cleaned = cleanupTask(); require(cleaned == ERROR_SUCCESS, cleaned, "Clean up completed naming task"); std::printf("{\"aliasesConfigured\":true}\n"); return ERROR_SUCCESS; }
        Sleep(500);
    }
    return ERROR_NOT_READY;
}
static DWORD install(IMMDeviceEnumerator* enumerator, const wchar_t* directoryArgument) {
    require(admin(), ERROR_ELEVATION_REQUIRED, "Administrator approval");
    wchar_t full[32768]; const DWORD length = GetFullPathNameW(directoryArgument, 32768, full, nullptr);
    require(length && length < 32768, ERROR_BAD_PATHNAME, "Resolve vendor directory");
    const std::wstring directory = full; verifyPackage(directory);
    const auto before = adapters();
    require(before.size() <= 1, ERROR_DUP_NAME, "Multiple VB-CABLE adapters; select or remove duplicates in Windows");
    if (!before.empty()) {
        require(before[0].problem == 0, ERROR_DEVICE_NOT_AVAILABLE, "Existing VB-CABLE is disabled or reports a device problem");
        bool renamed = false;
        if (owns(before)) for (unsigned attempt = 0; attempt < 10; ++attempt) {
            if (configureAliases(enumerator, before)) { renamed = true; break; }
            Sleep(500);
        }
        if (renamed) { const DWORD cleaned = cleanupTask(); require(cleaned == ERROR_SUCCESS, cleaned, "Clean up completed naming task"); }
        const auto audio = endpoints(enumerator, before); unsigned renderCount = 0, captureCount = 0;
        for (const auto& item : audio) if (item.main && item.state == DEVICE_STATE_ACTIVE) { if (item.flow == eRender) ++renderCount; else ++captureCount; }
        const bool needsRestart = renderCount != 1 || captureCount != 1 || (owns(before) && !renamed);
        if (needsRestart && owns(before)) deferAliases();
        std::printf("{\"installed\":true,\"reused\":true,\"aliasesConfigured\":%s,\"rebootRequired\":%s}\n", renamed ? "true" : "false", needsRestart ? "true" : "false");
        return needsRestart ? ERROR_SUCCESS_REBOOT_REQUIRED : ERROR_SUCCESS;
    }
    HDEVINFO devices = SetupDiCreateDeviceInfoList(&GUID_DEVCLASS_MEDIA, nullptr);
    require(devices != INVALID_HANDLE_VALUE, GetLastError(), "Create audio device information");
    SP_DEVINFO_DATA device = {}; device.cbSize = sizeof(device);
    bool registered = false;
    try {
        win32(SetupDiCreateDeviceInfoW(devices, L"MEDIA", &GUID_DEVCLASS_MEDIA, L"VB-Audio Virtual Cable", nullptr, DICD_GENERATE_ID, &device), "Create VB-CABLE adapter");
        const wchar_t ids[] = L"VBAudioVACWDM\0";
        win32(SetupDiSetDeviceRegistryPropertyW(devices, &device, SPDRP_HARDWAREID, reinterpret_cast<const BYTE*>(ids), sizeof(ids)), "Set original vendor hardware ID");
        win32(SetupDiCallClassInstaller(DIF_REGISTERDEVICE, devices, &device), "Register VB-CABLE adapter"); registered = true;
        BOOL restart = FALSE;
        win32(UpdateDriverForPlugAndPlayDevicesW(nullptr, HardwareId, (directory + L"\\vbMmeCable64_win10.inf").c_str(), INSTALLFLAG_NONINTERACTIVE, &restart), "Install original signed VB-CABLE driver");
        wchar_t instance[MAX_DEVICE_ID_LEN];
        win32(SetupDiGetDeviceInstanceIdW(devices, &device, instance, MAX_DEVICE_ID_LEN, nullptr), "Read installed adapter identity");
        const auto installed = adapters();
        require(installed.size() == 1 && equal(installed[0].id, instance), ERROR_NOT_FOUND, "Locate newly installed VB-CABLE");
        require(installed[0].problem == 0 || installed[0].problem == CM_PROB_NEED_RESTART, ERROR_DEVICE_NOT_AVAILABLE, "Windows could not start the signed VB-CABLE driver");
        rememberOwner(instance);
        SetupDiDestroyDeviceInfoList(devices); devices = INVALID_HANDLE_VALUE;
    } catch (...) {
        if (registered) { BOOL restart = FALSE; DiUninstallDevice(nullptr, devices, &device, 0, &restart); }
        if (devices != INVALID_HANDLE_VALUE) SetupDiDestroyDeviceInfoList(devices);
        throw;
    }
    bool configured = false;
    for (unsigned attempt = 0; attempt < 30; ++attempt) { if (configureAliases(enumerator, adapters())) { configured = true; break; } Sleep(500); }
    if (!configured) deferAliases();
    std::printf("{\"installed\":true,\"reused\":false,\"aliasesConfigured\":%s,\"rebootRequired\":true}\n", configured ? "true" : "false");
    return ERROR_SUCCESS_REBOOT_REQUIRED;
}
static DWORD removeOwned() {
    require(admin(), ERROR_ELEVATION_REQUIRED, "Administrator approval");
    const auto known = adapters(false);
    if (!owns(known)) { std::printf("{\"removed\":false,\"preservedSharedDevice\":true}\n"); return ERROR_SUCCESS; }
    HDEVINFO devices = SetupDiGetClassDevsW(&GUID_DEVCLASS_MEDIA, nullptr, nullptr, 0);
    require(devices != INVALID_HANDLE_VALUE, GetLastError(), "Enumerate owned audio device");
    SP_DEVINFO_DATA device = {}; device.cbSize = sizeof(device);
    if (!SetupDiOpenDeviceInfoW(devices, known[0].id.c_str(), nullptr, 0, &device)) { const DWORD error = GetLastError(); SetupDiDestroyDeviceInfoList(devices); return error; }
    BOOL restart = FALSE;
    const BOOL removed = DiUninstallDevice(nullptr, devices, &device, 0, &restart); const DWORD error = GetLastError();
    SetupDiDestroyDeviceInfoList(devices); require(removed, error, "Remove DDTrans-installed audio device");
    cleanupTask(); RegDeleteTreeW(HKEY_LOCAL_MACHINE, OwnerKey);
    std::printf("{\"removed\":true,\"rebootRequired\":%s}\n", restart ? "true" : "false");
    return restart ? ERROR_SUCCESS_REBOOT_REQUIRED : ERROR_SUCCESS;
}
int wmain(int argc, wchar_t** argv) {
    DWORD result = ERROR_BAD_ARGUMENTS;
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(initialized)) return static_cast<int>(initialized);
    {
        ComPtr<IMMDeviceEnumerator> enumerator;
        try {
            check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(enumerator.GetAddressOf())), "Open Windows audio devices");
            if (argc == 2 && wcscmp(argv[1], L"status") == 0) result = status(enumerator.Get());
            else if (argc == 3 && wcscmp(argv[1], L"install") == 0) result = install(enumerator.Get(), argv[2]);
            else if (argc == 2 && wcscmp(argv[1], L"configure") == 0) result = configure(enumerator.Get());
            else if (argc == 2 && wcscmp(argv[1], L"remove-owned") == 0) result = removeOwned();
            else if (argc == 2 && wcscmp(argv[1], L"cleanup-task") == 0) result = cleanupTask();
            else if (argc == 3 && wcscmp(argv[1], L"verify-package") == 0) { verifyPackage(argv[2]); std::printf("{\"packageVerified\":true}\n"); result = ERROR_SUCCESS; }
        } catch (DWORD error) { result = error; }
        catch (...) { result = ERROR_UNHANDLED_EXCEPTION; }
    }
    CoUninitialize();
    if (result != ERROR_SUCCESS && result != ERROR_SUCCESS_REBOOT_REQUIRED) std::fprintf(stderr, "DDTrans virtual audio operation failed: %lu\n", result);
    return static_cast<int>(result);
}

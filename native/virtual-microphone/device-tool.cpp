// SPDX-License-Identifier: MIT
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <setupapi.h>
#include <newdev.h>
#include <devguid.h>
#include <cfgmgr32.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>
#include "endpoint-names.h"

static const wchar_t* HardwareId = L"ROOT\\DDTransVirtualAudio";
static bool matches(HDEVINFO devices, SP_DEVINFO_DATA* device) {
    wchar_t ids[4096] = {}; DWORD type = 0, bytes = 0;
    if (!SetupDiGetDeviceRegistryPropertyW(devices, device, SPDRP_HARDWAREID, &type, reinterpret_cast<BYTE*>(ids), sizeof(ids), &bytes) || type != REG_MULTI_SZ) return false;
    for (const wchar_t* id = ids; *id; id += wcslen(id) + 1) if (_wcsicmp(id, HardwareId) == 0) return true;
    return false;
}
static std::string utf8(const wchar_t* text) {
    const int count = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<size_t>(count), 0);
    WideCharToMultiByte(CP_UTF8, 0, text, -1, result.data(), count, nullptr, nullptr); result.pop_back(); return result;
}
static void quoted(const wchar_t* text) {
    std::putchar('"'); for (unsigned char c : utf8(text)) { if (c == '"' || c == '\\') std::putchar('\\'); if (c < 32) std::printf("\\u%04x", c); else std::putchar(c); } std::putchar('"');
}
static int status() {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(initialized)) return 1;
    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr)) { CoUninitialize(); return 1; }
    struct IntegrityInformation { ULONG length, options; } integrity = {8, 0};
    using QuerySystem = LONG (WINAPI*)(ULONG, void*, ULONG, ULONG*);
    const auto query = reinterpret_cast<QuerySystem>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySystemInformation"));
    ULONG returned = 0; const LONG integrityStatus = query ? query(103, &integrity, sizeof(integrity), &returned) : -1;
    unsigned renderCount = 0, captureCount = 0; bool comma = false;
    std::printf("{\"endpoints\":[");
    for (const EDataFlow direction : {eRender, eCapture}) {
        IMMDeviceCollection* collection = nullptr;
        if (FAILED(enumerator->EnumAudioEndpoints(direction, DEVICE_STATEMASK_ALL, &collection))) continue;
        UINT count = 0; collection->GetCount(&count);
        for (UINT index = 0; index < count; ++index) {
            IMMDevice* device = nullptr; IPropertyStore* properties = nullptr; PROPVARIANT name; PropVariantInit(&name);
            if (FAILED(collection->Item(index, &device))) continue;
            if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &properties)) && SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &name)) && name.vt == VT_LPWSTR && (DdtransEndpointNameMatches(name.pwszVal, L"DDTrans Virtual Input") || DdtransEndpointNameMatches(name.pwszVal, L"DDTrans Virtual Microphone"))) {
                DWORD state = 0; LPWSTR id = nullptr; device->GetState(&state); device->GetId(&id);
                if (comma) std::putchar(','); comma = true;
                std::printf("{\"flow\":\"%s\",\"state\":%lu,\"name\":", direction == eRender ? "render" : "capture", state); quoted(name.pwszVal); std::printf(",\"id\":"); quoted(id ? id : L""); std::putchar('}');
                if (state == DEVICE_STATE_ACTIVE) { if (direction == eRender && DdtransEndpointNameMatches(name.pwszVal, L"DDTrans Virtual Input")) ++renderCount; if (direction == eCapture && DdtransEndpointNameMatches(name.pwszVal, L"DDTrans Virtual Microphone")) ++captureCount; }
                CoTaskMemFree(id);
            }
            PropVariantClear(&name); if (properties) properties->Release(); device->Release();
        }
        collection->Release();
    }
    std::printf("],\"activeRenderCount\":%u,\"activeCaptureCount\":%u,\"ready\":%s,\"codeIntegrityQueryStatus\":%ld,\"testSigningEnabled\":%s,\"hvciEnabled\":%s}\n", renderCount, captureCount, renderCount == 1 && captureCount == 1 ? "true" : "false", integrityStatus, integrityStatus == 0 ? (integrity.options & 2 ? "true" : "false") : "null", integrityStatus == 0 ? (integrity.options & 1024 ? "true" : "false") : "null");
    enumerator->Release(); CoUninitialize(); return 0;
}
static int install(const wchar_t* infArgument) {
    wchar_t inf[MAX_PATH];
    const DWORD length = GetFullPathNameW(infArgument, MAX_PATH, inf, nullptr);
    if (!length || length >= MAX_PATH || GetFileAttributesW(inf) == INVALID_FILE_ATTRIBUTES) return ERROR_FILE_NOT_FOUND;
    HDEVINFO devices = SetupDiGetClassDevsW(&GUID_DEVCLASS_MEDIA, nullptr, nullptr, 0);
    if (devices == INVALID_HANDLE_VALUE) return static_cast<int>(GetLastError());
    SP_DEVINFO_DATA device = {}; device.cbSize = sizeof(device); bool existing = false;
    for (DWORD index = 0; SetupDiEnumDeviceInfo(devices, index, &device); ++index) if (matches(devices, &device)) { existing = true; break; }
    if (!existing) {
        if (!SetupDiCreateDeviceInfoW(devices, L"MEDIA", &GUID_DEVCLASS_MEDIA, L"DDTrans Virtual Audio", nullptr, DICD_GENERATE_ID, &device)) { const DWORD error = GetLastError(); SetupDiDestroyDeviceInfoList(devices); return static_cast<int>(error); }
        const wchar_t hardwareIds[] = L"ROOT\\DDTransVirtualAudio\0";
        if (!SetupDiSetDeviceRegistryPropertyW(devices, &device, SPDRP_HARDWAREID, reinterpret_cast<const BYTE*>(hardwareIds), sizeof(hardwareIds)) || !SetupDiCallClassInstaller(DIF_REGISTERDEVICE, devices, &device)) { const DWORD error = GetLastError(); SetupDiDestroyDeviceInfoList(devices); return static_cast<int>(error); }
    }
    BOOL reboot = FALSE;
    if (!UpdateDriverForPlugAndPlayDevicesW(nullptr, HardwareId, inf, INSTALLFLAG_NONINTERACTIVE, &reboot)) {
        const DWORD error = GetLastError();
        if (!existing) { SP_REMOVEDEVICE_PARAMS remove = {}; remove.ClassInstallHeader.cbSize = sizeof(SP_CLASSINSTALL_HEADER); remove.ClassInstallHeader.InstallFunction = DIF_REMOVE; remove.Scope = DI_REMOVEDEVICE_GLOBAL; SetupDiSetClassInstallParamsW(devices, &device, &remove.ClassInstallHeader, sizeof(remove)); SetupDiCallClassInstaller(DIF_REMOVE, devices, &device); }
        SetupDiDestroyDeviceInfoList(devices); return static_cast<int>(error);
    }
    SetupDiDestroyDeviceInfoList(devices);
    std::printf("{\"installed\":true,\"rebootRequired\":%s}\n", reboot ? "true" : "false");
    return reboot ? ERROR_SUCCESS_REBOOT_REQUIRED : 0;
}
static int removeDevices() {
    HDEVINFO devices = SetupDiGetClassDevsW(&GUID_DEVCLASS_MEDIA, nullptr, nullptr, 0);
    if (devices == INVALID_HANDLE_VALUE) return static_cast<int>(GetLastError());
    std::vector<std::wstring> instances, driverPackages;
    SP_DEVINFO_DATA device = {}; device.cbSize = sizeof(device);
    for (DWORD index = 0; SetupDiEnumDeviceInfo(devices, index, &device); ++index) {
        if (!matches(devices, &device)) continue;
        HKEY driverKey = SetupDiOpenDevRegKey(devices, &device, DICS_FLAG_GLOBAL, 0, DIREG_DRV, KEY_QUERY_VALUE);
        if (driverKey != INVALID_HANDLE_VALUE) {
            wchar_t infName[MAX_PATH] = {}; DWORD bytes = sizeof(infName);
            if (RegGetValueW(driverKey, nullptr, L"InfPath", RRF_RT_REG_SZ, nullptr, infName, &bytes) == ERROR_SUCCESS && wcsncmp(infName, L"oem", 3) == 0 && !wcschr(infName, L'\\') && !wcschr(infName, L'/')) {
                wchar_t windowsPath[MAX_PATH]; GetWindowsDirectoryW(windowsPath, MAX_PATH);
                const std::wstring path = std::wstring(windowsPath) + L"\\INF\\" + infName;
                bool found = false; for (const auto& known : driverPackages) if (known == path) found = true;
                if (!found) driverPackages.push_back(path);
            }
            RegCloseKey(driverKey);
        }
        wchar_t id[MAX_DEVICE_ID_LEN]; if (!SetupDiGetDeviceInstanceIdW(devices, &device, id, MAX_DEVICE_ID_LEN, nullptr)) { SetupDiDestroyDeviceInfoList(devices); return static_cast<int>(GetLastError()); } instances.emplace_back(id);
    }
    BOOL anyReboot = FALSE;
    for (const auto& id : instances) {
        SP_DEVINFO_DATA selected = {}; selected.cbSize = sizeof(selected);
        if (!SetupDiOpenDeviceInfoW(devices, id.c_str(), nullptr, 0, &selected)) { const DWORD error = GetLastError(); SetupDiDestroyDeviceInfoList(devices); return static_cast<int>(error); }
        BOOL reboot = FALSE;
        if (!DiUninstallDevice(nullptr, devices, &selected, 0, &reboot)) { const DWORD error = GetLastError(); SetupDiDestroyDeviceInfoList(devices); return static_cast<int>(error); }
        anyReboot = anyReboot || reboot;
    }
    SetupDiDestroyDeviceInfoList(devices);
    for (const auto& driver : driverPackages) {
        BOOL reboot = FALSE;
        if (!DiUninstallDriverW(nullptr, driver.c_str(), 0, &reboot)) return static_cast<int>(GetLastError());
        anyReboot = anyReboot || reboot;
    }
    std::printf("{\"removedDevices\":%zu,\"rebootRequired\":%s}\n", instances.size(), anyReboot ? "true" : "false");
    return anyReboot ? ERROR_SUCCESS_REBOOT_REQUIRED : 0;
}
int wmain(int argc, wchar_t** argv) {
    const int result = argc == 2 && wcscmp(argv[1], L"status") == 0 ? status() : argc == 3 && wcscmp(argv[1], L"install") == 0 ? install(argv[2]) : argc == 2 && wcscmp(argv[1], L"remove") == 0 ? removeDevices() : ERROR_BAD_ARGUMENTS;
    if (result && result != ERROR_SUCCESS_REBOOT_REQUIRED) std::fprintf(stderr, "DDTrans device operation failed (Win32 %d).\n", result);
    return result;
}

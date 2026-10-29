// SPDX-License-Identifier: MIT
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <ks.h>
#include <ksmedia.h>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <algorithm>
#include "endpoint-names.h"

static void check(HRESULT result) { if (FAILED(result)) { char error[80]; std::snprintf(error, sizeof(error), "WASAPI failure 0x%08lx", static_cast<unsigned long>(result)); throw std::runtime_error(error); } }
struct ProbeStream { IMMDevice* device = nullptr; IAudioClient* client = nullptr; WAVEFORMATEX* format = nullptr; IAudioRenderClient* render = nullptr; IAudioCaptureClient* capture = nullptr; };
static void closeStream(ProbeStream& stream) { if (stream.client) stream.client->Stop(); if (stream.render) stream.render->Release(); if (stream.capture) stream.capture->Release(); CoTaskMemFree(stream.format); if (stream.client) stream.client->Release(); if (stream.device) stream.device->Release(); }
static void openStream(IMMDeviceEnumerator* enumerator, EDataFlow flow, const wchar_t* name, ProbeStream& stream) {
    IMMDeviceCollection* devices = nullptr; check(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &devices)); UINT count = 0; check(devices->GetCount(&count)); unsigned matched = 0;
    for (UINT index = 0; index < count; ++index) {
        IMMDevice* device = nullptr; IPropertyStore* properties = nullptr; PROPVARIANT value; PropVariantInit(&value);
        if (SUCCEEDED(devices->Item(index, &device))) {
            if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &properties)) && SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR && DdtransEndpointNameMatches(value.pwszVal, name)) { ++matched; if (!stream.device) { stream.device = device; device->AddRef(); } }
            PropVariantClear(&value); if (properties) properties->Release(); device->Release();
        }
    }
    devices->Release();
    if (matched != 1) throw std::runtime_error("Expected exactly one active DDTrans endpoint for each direction; install/enable the driver first.");
    check(stream.device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&stream.client)));
    check(stream.client->GetMixFormat(&stream.format));
    if (stream.format->nChannels != 1 || stream.format->nSamplesPerSec != 48000) throw std::runtime_error("Endpoint format must be 48 kHz mono.");
    const WORD tag = stream.format->wFormatTag;
    const bool floating = tag == WAVE_FORMAT_IEEE_FLOAT || (tag == WAVE_FORMAT_EXTENSIBLE && IsEqualGUID(reinterpret_cast<WAVEFORMATEXTENSIBLE*>(stream.format)->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT));
    if (!(stream.format->wBitsPerSample == 16 || (floating && stream.format->wBitsPerSample == 32))) throw std::runtime_error("Unsupported shared-mode mix representation.");
    check(stream.client->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1000000, 0, stream.format, nullptr));
    if (flow == eRender) check(stream.client->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(&stream.render)));
    else check(stream.client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&stream.capture)));
}
int main() {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED); if (FAILED(initialized)) return 1;
    IMMDeviceEnumerator* enumerator = nullptr; ProbeStream render, capture; int exitCode = 1;
    try {
        check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator)));
        openStream(enumerator, eRender, L"DDTrans Virtual Input", render); openStream(enumerator, eCapture, L"DDTrans Virtual Microphone", capture);
        UINT32 capacity = 0; check(render.client->GetBufferSize(&capacity)); unsigned long long rendered = 0, received = 0, measured = 0, silentMeasured = 0; double sine = 0, cosine = 0, maxAfterStop = 0; const double pi = 3.14159265358979323846;
        BYTE* data = nullptr; check(render.render->GetBuffer(capacity, &data)); ZeroMemory(data, capacity * render.format->nBlockAlign); check(render.render->ReleaseBuffer(capacity, AUDCLNT_BUFFERFLAGS_SILENT));
        check(capture.client->Start()); check(render.client->Start()); const ULONGLONG started = GetTickCount64(); bool stopped = false;
        while (GetTickCount64() - started < 1700) {
            const ULONGLONG elapsed = GetTickCount64() - started;
            if (!stopped && elapsed >= 1200) { check(render.client->Stop()); stopped = true; }
            if (!stopped) {
                UINT32 padding = 0; check(render.client->GetCurrentPadding(&padding)); const UINT32 available = capacity - padding;
                if (available) { check(render.render->GetBuffer(available, &data)); for (UINT32 i = 0; i < available; ++i) { const double value = 0.08 * std::sin(2 * pi * 997 * static_cast<double>(rendered++) / 48000); if (render.format->wBitsPerSample == 16) reinterpret_cast<short*>(data)[i] = static_cast<short>(value * 32767); else reinterpret_cast<float*>(data)[i] = static_cast<float>(value); } check(render.render->ReleaseBuffer(available, 0)); }
            }
            UINT32 packet = 0; check(capture.capture->GetNextPacketSize(&packet));
            while (packet) {
                UINT32 frames = 0; DWORD flags = 0; check(capture.capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr));
                for (UINT32 i = 0; i < frames; ++i) {
                    const double value = flags & AUDCLNT_BUFFERFLAGS_SILENT ? 0 : capture.format->wBitsPerSample == 16 ? reinterpret_cast<short*>(data)[i] / 32768.0 : reinterpret_cast<float*>(data)[i];
                    const double phase = 2 * pi * 997 * static_cast<double>(received++) / 48000;
                    if (elapsed >= 200 && elapsed < 1100) { sine += value * std::sin(phase); cosine += value * std::cos(phase); ++measured; }
                    if (elapsed >= 1450) { maxAfterStop = (std::max)(maxAfterStop, std::abs(value)); ++silentMeasured; }
                }
                check(capture.capture->ReleaseBuffer(frames)); check(capture.capture->GetNextPacketSize(&packet));
            }
            Sleep(5);
        }
        const double amplitude = measured ? 2 * std::sqrt(sine*sine + cosine*cosine) / static_cast<double>(measured) : 0;
        const bool passed = amplitude > 0.02 && amplitude < 0.12 && silentMeasured > 4800 && maxAfterStop < 0.0001;
        std::printf("{\"mode\":\"native-wasapi-render-to-capture\",\"receivedSamples\":%llu,\"toneAmplitude\":%.8f,\"silenceSamples\":%llu,\"peakAfterStop\":%.8f,\"passed\":%s}\n", received, amplitude, silentMeasured, maxAfterStop, passed ? "true" : "false");
        exitCode = passed ? 0 : 1;
    } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); }
    closeStream(render); closeStream(capture); if (enumerator) enumerator->Release(); CoUninitialize(); return exitCode;
}

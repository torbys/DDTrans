// SPDX-License-Identifier: MIT
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <ksmedia.h>
#include <wrl/client.h>
#include <cstdio>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <algorithm>
using Microsoft::WRL::ComPtr;
static void check(HRESULT value) { if (FAILED(value)) { std::fprintf(stderr, "WASAPI failed: 0x%08lx\n", static_cast<unsigned long>(value)); throw std::runtime_error("WASAPI operation failed"); } }
static bool floating(const WAVEFORMATEX* format) {
    return format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT || (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE && IsEqualGUID(reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format)->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT));
}
static double sample(const BYTE* data, const WAVEFORMATEX* format) {
    if (floating(format) && format->wBitsPerSample == 32) return *reinterpret_cast<const float*>(data);
    if (format->wBitsPerSample == 16) return *reinterpret_cast<const short*>(data) / 32768.0;
    if (format->wBitsPerSample == 24) { const int value = static_cast<int>((static_cast<unsigned>(data[2]) << 24) | (static_cast<unsigned>(data[1]) << 16) | (static_cast<unsigned>(data[0]) << 8)); return value / 2147483648.0; }
    if (format->wBitsPerSample == 32) return *reinterpret_cast<const int*>(data) / 2147483648.0;
    throw std::runtime_error("Unsupported capture sample format");
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 3) { std::fprintf(stderr, "Usage: ddtrans-audio-probe.exe <render-endpoint-id> <capture-endpoint-id>\nUse the validated IDs from ddtrans-audio-device.exe status.\n"); return 2; }
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(initialized)) return 1;
    int result = 1;
    {
        ComPtr<IMMDeviceEnumerator> enumerator; ComPtr<IMMDevice> render, capture;
        ComPtr<IAudioClient> writer, reader; ComPtr<IAudioRenderClient> output; ComPtr<IAudioCaptureClient> input;
        WAVEFORMATEX* inputFormat = nullptr; bool readerStarted = false, writerStarted = false;
        try {
            check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(enumerator.GetAddressOf())));
            check(enumerator->GetDevice(argv[1], render.GetAddressOf())); check(enumerator->GetDevice(argv[2], capture.GetAddressOf()));
            check(render->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(writer.GetAddressOf())));
            check(capture->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(reader.GetAddressOf())));
            WAVEFORMATEX outputFormat = {}; outputFormat.wFormatTag = WAVE_FORMAT_IEEE_FLOAT; outputFormat.nChannels = 2; outputFormat.nSamplesPerSec = 48000; outputFormat.wBitsPerSample = 32; outputFormat.nBlockAlign = 8; outputFormat.nAvgBytesPerSec = 384000;
            check(writer->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 1000000, 0, &outputFormat, nullptr));
            check(reader->GetMixFormat(&inputFormat));
            check(reader->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1000000, 0, inputFormat, nullptr));
            check(writer->GetService(IID_PPV_ARGS(output.GetAddressOf()))); check(reader->GetService(IID_PPV_ARGS(input.GetAddressOf())));
            UINT32 bufferFrames = 0; check(writer->GetBufferSize(&bufferFrames));
            check(reader->Start()); readerStarted = true; check(writer->Start()); writerStarted = true;
            const double pi = 3.14159265358979323846; unsigned long long sent = 0, received = 0, measured = 0, silence = 0;
            double sine = 0, cosine = 0, peakAfterStop = 0; const ULONGLONG began = GetTickCount64();
            while (GetTickCount64() - began < 2400) {
                const ULONGLONG elapsed = GetTickCount64() - began;
                if (elapsed >= 1200 && writerStarted) { check(writer->Stop()); check(writer->Reset()); writerStarted = false; }
                if (writerStarted) {
                    UINT32 padding = 0; check(writer->GetCurrentPadding(&padding)); const UINT32 frames = bufferFrames - padding;
                    if (frames) {
                        BYTE* data = nullptr; check(output->GetBuffer(frames, &data));
                        for (UINT32 frame = 0; frame < frames; ++frame) {
                            const float value = static_cast<float>(0.08 * std::sin(2 * pi * 997 * static_cast<double>(sent++) / 48000));
                            reinterpret_cast<float*>(data)[frame * 2] = value; reinterpret_cast<float*>(data)[frame * 2 + 1] = value;
                        }
                        check(output->ReleaseBuffer(frames, 0));
                    }
                }
                UINT32 packet = 0; check(input->GetNextPacketSize(&packet));
                while (packet) {
                    BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
                    check(input->GetBuffer(&data, &frames, &flags, nullptr, nullptr));
                    for (UINT32 frame = 0; frame < frames; ++frame) {
                        const double value = flags & AUDCLNT_BUFFERFLAGS_SILENT ? 0 : sample(data + static_cast<size_t>(frame) * inputFormat->nBlockAlign, inputFormat);
                        const double phase = 2 * pi * 997 * static_cast<double>(received++) / inputFormat->nSamplesPerSec;
                        if (elapsed >= 300 && elapsed < 1100) { sine += value * std::sin(phase); cosine += value * std::cos(phase); ++measured; }
                        if (elapsed >= 1900) { peakAfterStop = std::max(peakAfterStop, std::abs(value)); ++silence; }
                    }
                    check(input->ReleaseBuffer(frames)); check(input->GetNextPacketSize(&packet));
                }
                Sleep(4);
            }
            const double amplitude = measured ? 2 * std::sqrt(sine * sine + cosine * cosine) / static_cast<double>(measured) : 0;
            const bool passed = amplitude > 0.02 && amplitude < 0.12 && silence > inputFormat->nSamplesPerSec / 5 && peakAfterStop < 0.0001;
            std::printf("{\"mode\":\"native-wasapi-render-to-capture\",\"provider\":\"VB-CABLE\",\"captureRate\":%lu,\"captureChannels\":%u,\"toneAmplitude\":%.8f,\"silenceSamples\":%llu,\"peakAfterStop\":%.8f,\"passed\":%s}\n", inputFormat->nSamplesPerSec, inputFormat->nChannels, amplitude, silence, peakAfterStop, passed ? "true" : "false");
            result = passed ? 0 : 1;
        } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); }
        if (writerStarted) writer->Stop(); if (readerStarted) reader->Stop(); CoTaskMemFree(inputFormat);
    }
    CoUninitialize(); return result;
}

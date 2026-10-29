// SPDX-License-Identifier: MIT
#pragma once
#include "audio-ring.h"

struct DdtransAudioBridge {
    KSPIN_LOCK lock;
    DdtransAudioRing ring;
    ULONGLONG lastWriteTime;
};
inline void DdtransBridgeInitialize(DdtransAudioBridge* bridge) {
    RtlZeroMemory(bridge, sizeof(*bridge));
    KeInitializeSpinLock(&bridge->lock);
}
inline void DdtransBridgeClear(DdtransAudioBridge* bridge) {
    KIRQL previous;
    KeAcquireSpinLock(&bridge->lock, &previous);
    DdtransRingClear(&bridge->ring);
    KeReleaseSpinLock(&bridge->lock, previous);
}
inline void DdtransBridgeSetProducer(DdtransAudioBridge* bridge, bool running) {
    KIRQL previous;
    KeAcquireSpinLock(&bridge->lock, &previous);
    DdtransRingSetProducer(&bridge->ring, running);
    bridge->lastWriteTime = KeQueryInterruptTime();
    KeReleaseSpinLock(&bridge->lock, previous);
}
inline void DdtransBridgeWrite(DdtransAudioBridge* bridge, const void* source, ULONG bytes) {
    KIRQL previous;
    KeAcquireSpinLock(&bridge->lock, &previous);
    DdtransRingWrite(&bridge->ring, static_cast<const DdSample*>(source), bytes / sizeof(DdSample));
    bridge->lastWriteTime = KeQueryInterruptTime();
    KeReleaseSpinLock(&bridge->lock, previous);
}
inline void DdtransBridgeRead(DdtransAudioBridge* bridge, void* destination, ULONG bytes) {
    KIRQL previous;
    KeAcquireSpinLock(&bridge->lock, &previous);
    if (KeQueryInterruptTime() - bridge->lastWriteTime > 1000000) DdtransRingClear(&bridge->ring);
    DdtransRingRead(&bridge->ring, static_cast<DdSample*>(destination), bytes / sizeof(DdSample));
    KeReleaseSpinLock(&bridge->lock, previous);
}

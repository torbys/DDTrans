// SPDX-License-Identifier: MIT
#pragma once
#include <cwchar>
#include <string>

inline bool DdtransEndpointNameMatches(const wchar_t* actual, const wchar_t* expected) {
    if (!actual) return false;
    return std::wcscmp(actual, expected) == 0 || std::wstring(actual) == std::wstring(expected) + L" (DDTrans Virtual Audio)";
}

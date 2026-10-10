#include <algorithm>
#include <cassert>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <vector>
using HANDLE = void*;
using HMODULE = void*;
using HPCON = void*;
using LONG = long;
using LPDWORD = unsigned int*;
using PFNCLOSEPSEUDOCONSOLE = void (*)(HPCON);
constexpr int INFINITE = -1;
static int consoles = 0, shells = 0, notifications = 0;
static bool libraryAvailable = true, closeAvailable = true;
namespace Napi {
struct Number { int value; int Int32Value() const { return value; } static Number New(struct Env, int); };
struct Boolean { bool value; bool Value() const { return value; } };
struct Value {
  int number = 0; bool boolean = false; bool isBoolean = false;
  bool IsNumber() const { return !isBoolean; } bool IsBoolean() const { return isBoolean; }
  template<class T> T As() const { if constexpr (std::is_same_v<T, Number>) return {number}; else return {boolean}; }
};
struct Env { Value Undefined() const { return {}; } };
Number Number::New(Env, int value) { return {value}; }
struct HandleScope { explicit HandleScope(struct Env) {} };
struct CallbackInfo {
  int id; bool dll;
  auto Env() const -> struct Env { return {}; }
  int Length() const { return 2; }
  Value operator[](int i) const { return i == 0 ? Value{id, false, false} : Value{0, dll, true}; }
};
struct Error { static std::runtime_error New(struct Env, const char* message) { return std::runtime_error(message); } };
struct Function { void Call(std::initializer_list<Number>) const { ++notifications; } };
}
static void CloseHandle(HANDLE handle) { assert(handle != nullptr); --shells; }
static void WaitForSingleObject(HANDLE, int) {}
static void GetExitCodeProcess(HANDLE, LPDWORD result) { *result = 0; }
static void closeConsole(HPCON console) { assert(console != nullptr); --consoles; }
static HANDLE LoadConptyDll(const Napi::CallbackInfo&, bool) { return libraryAvailable ? reinterpret_cast<HANDLE>(1) : nullptr; }
static auto GetProcAddress(HMODULE, const char*) { return closeAvailable ? &closeConsole : nullptr; }
static void TerminateProcess(HANDLE shell, int) { assert(shell != nullptr); }
static auto errorWithCode(const Napi::CallbackInfo& info, const char* text) { return Napi::Error::New(info.Env(), text); }
// NATIVE DECLARATIONS
// NATIVE KILL
static void create(int id) {
  auto baton = std::make_unique<pty_baton>(id, nullptr, nullptr, reinterpret_cast<HPCON>(1));
  baton->hShell = reinterpret_cast<HANDLE>(2);
  ptyHandles.push_back(std::move(baton)); ++consoles; ++shells;
}
static void nativeExit(int id) {
  auto* baton = get_pty_baton(id);
  assert(baton != nullptr);
  // NATIVE CALLBACK
  // NATIVE WAIT
  callback(Napi::Env{}, Napi::Function{}, exit_event);
}
int main() {
  create(1);
  nativeExit(1);
  assert(notifications == 1 && shells == 0 && consoles == 1);
  assert(get_pty_baton(1) != nullptr); // Owned console survives exit notification until JS drains output.
  PtyKill({1, false});
  assert(consoles == 0 && get_pty_baton(1) == nullptr);
  PtyKill({1, false});
  assert(consoles == 0);
  create(2);
  PtyKill({2, false});
  assert(consoles == 0 && shells == 1 && get_pty_baton(2) != nullptr);
  PtyKill({2, false});
  assert(consoles == 0);
  nativeExit(2);
  assert(notifications == 2 && shells == 0 && get_pty_baton(2) == nullptr);
  PtyKill({2, false});
  assert(consoles == 0);
  create(3);
  PtyKill({3, true});
  nativeExit(3);
  assert(consoles == 0 && shells == 0 && ptyHandles.empty());
  create(4); create(5);
  nativeExit(4); nativeExit(5);
  PtyKill({5, false});
  assert(consoles == 1 && get_pty_baton(4) != nullptr && get_pty_baton(5) == nullptr);
  libraryAvailable = false;
  try { PtyKill({4, false}); assert(false); } catch (const std::runtime_error&) {}
  assert(consoles == 1 && get_pty_baton(4) != nullptr);
  libraryAvailable = true; closeAvailable = false;
  try { PtyKill({4, false}); assert(false); } catch (const std::runtime_error&) {}
  assert(consoles == 1 && get_pty_baton(4) != nullptr);
  closeAvailable = true;
  PtyKill({4, false});
  assert(consoles == 0 && ptyHandles.empty());
  create(6);
  nativeExit(6);
  assert(shells == 0 && consoles == 1 && get_pty_baton(6) != nullptr);
  PtyKill({6, true}); // Natural DLL-mode cleanup closes the console without a live shell handle.
  assert(consoles == 0 && ptyHandles.empty());
  std::cout << "native ownership released exactly once\n";
}

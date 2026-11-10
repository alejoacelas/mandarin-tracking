package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit -framework CoreGraphics
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdlib.h>
#include <string.h>

// The frontmost app is the owner of the topmost normal window. NSWorkspace's
// frontmostApplication goes stale in a process without a run loop, so it isn't used.
static char* mt_front_bundle(void) {
  @autoreleasepool {
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (!list) return strdup("");
    int pid = -1;
    for (CFIndex i = 0; i < CFArrayGetCount(list); i++) {
      CFDictionaryRef d = CFArrayGetValueAtIndex(list, i);
      int layer = 1;
      CFNumberRef l = CFDictionaryGetValue(d, kCGWindowLayer);
      if (l) CFNumberGetValue(l, kCFNumberIntType, &layer);
      if (layer != 0) continue;
      CFNumberRef p = CFDictionaryGetValue(d, kCGWindowOwnerPID);
      if (p) CFNumberGetValue(p, kCFNumberIntType, &pid);
      break;
    }
    CFRelease(list);
    if (pid < 0) return strdup("");
    NSRunningApplication *a = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    return strdup(a && a.bundleIdentifier ? [a.bundleIdentifier UTF8String] : "");
  }
}

static double mt_idle_seconds(void) {
  return CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGAnyInputEventType);
}

static int mt_locked(void) {
  CFDictionaryRef d = CGSessionCopyCurrentDictionary();
  if (!d) return 1; // no GUI session: nobody can be using an app
  int locked = 0;
  CFBooleanRef v = CFDictionaryGetValue(d, CFSTR("CGSSessionScreenIsLocked"));
  if (v && CFBooleanGetValue(v)) locked = 1;
  CFBooleanRef on = CFDictionaryGetValue(d, kCGSessionOnConsoleKey);
  if (on && !CFBooleanGetValue(on)) locked = 1; // another user is on the console
  CFRelease(d);
  return locked;
}
*/
import "C"

import (
	"time"
	"unsafe"
)

func SampleMac() MacSample {
	b := C.mt_front_bundle()
	defer C.free(unsafe.Pointer(b))
	return MacSample{
		At:     time.Now(),
		Bundle: C.GoString(b),
		Idle:   time.Duration(float64(C.mt_idle_seconds()) * float64(time.Second)),
		Locked: C.mt_locked() != 0,
	}
}

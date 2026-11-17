import { describe, expect, test } from "bun:test";
import {
  tlsProfileOf,
} from "../../src/network/egress/tls-profile";

describe("TLS profiles (ClientHello/custom support)", () => {
  test("tlsProfileOf maps default/unknown to undefined", () => {
    expect(tlsProfileOf("default")).toBeUndefined();
    expect(tlsProfileOf(undefined as never)).toBeUndefined();
    expect(tlsProfileOf("no-such-profile")).toBeUndefined();
  });
});

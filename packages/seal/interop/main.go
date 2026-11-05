// Command interop opens boxes that the TypeScript sealer made, the way the egress proxy will
//
// It reads one JSON document on stdin with a box key pair and cases, and exits non-zero on the
// first case whose box does not open, or opens to a payload other than the one expected
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"slices"

	"golang.org/x/crypto/nacl/box"
)

type payload struct {
	V         int      `json:"v"`
	Binding   string   `json:"binding"`
	Name      string   `json:"name"`
	Hosts     []string `json:"hosts"`
	Headers   []string `json:"headers"`
	FetchOnly bool     `json:"fetchOnly"`
	Value     string   `json:"value"`
}

type testCase struct {
	Box        string  `json:"box"`
	ExpectOpen bool    `json:"expectOpen"`
	Expect     payload `json:"expect"`
}

type input struct {
	PublicKey  string     `json:"publicKey"`
	PrivateKey string     `json:"privateKey"`
	Cases      []testCase `json:"cases"`
}

// The order data-plane 10.2 gives, which the TypeScript side must keep
var fieldOrder = []string{"v", "binding", "name", "hosts", "headers", "fetchOnly", "value"}

func key(s string) (*[32]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) != 32 {
		return nil, fmt.Errorf("bad key")
	}
	var k [32]byte
	copy(k[:], b)
	return &k, nil
}

func topLevelKeys(plain []byte) ([]string, error) {
	dec := json.NewDecoder(bytes.NewReader(plain))
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	var keys []string
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil, err
		}
		keys = append(keys, t.(string))
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return nil, err
		}
	}
	return keys, nil
}

func check(c testCase, pub, priv *[32]byte) error {
	sealed, err := base64.RawURLEncoding.DecodeString(c.Box)
	if err != nil {
		return fmt.Errorf("box is not base64url without padding")
	}
	plain, ok := box.OpenAnonymous(nil, sealed, pub, priv)
	if ok != c.ExpectOpen {
		return fmt.Errorf("opened %v, want %v", ok, c.ExpectOpen)
	}
	if !ok {
		return nil
	}
	keys, err := topLevelKeys(plain)
	if err != nil || !slices.Equal(keys, fieldOrder) {
		return fmt.Errorf("payload fields %v, want %v", keys, fieldOrder)
	}
	var got payload
	dec := json.NewDecoder(bytes.NewReader(plain))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&got); err != nil {
		return fmt.Errorf("payload does not decode: %v", err)
	}
	if got.V != c.Expect.V || got.Binding != c.Expect.Binding || got.Name != c.Expect.Name ||
		!slices.Equal(got.Hosts, c.Expect.Hosts) || !slices.Equal(got.Headers, c.Expect.Headers) ||
		got.FetchOnly != c.Expect.FetchOnly || got.Value != c.Expect.Value {
		return fmt.Errorf("payload differs from the one sealed")
	}
	return nil
}

func main() {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read stdin:", err)
		os.Exit(2)
	}
	var in input
	if err := json.Unmarshal(raw, &in); err != nil {
		fmt.Fprintln(os.Stderr, "decode input:", err)
		os.Exit(2)
	}
	pub, err1 := key(in.PublicKey)
	priv, err2 := key(in.PrivateKey)
	if err1 != nil || err2 != nil {
		fmt.Fprintln(os.Stderr, "bad key pair")
		os.Exit(2)
	}
	opened := 0
	for i, c := range in.Cases {
		if err := check(c, pub, priv); err != nil {
			fmt.Fprintf(os.Stderr, "case %d: %v\n", i, err)
			os.Exit(1)
		}
		if c.ExpectOpen {
			opened++
		}
	}
	fmt.Printf("opened %d boxes, refused %d\n", opened, len(in.Cases)-opened)
}

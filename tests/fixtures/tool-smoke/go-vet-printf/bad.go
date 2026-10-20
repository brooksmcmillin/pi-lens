package main

import "fmt"

// Capture workspace for #4451. Unlike tool-smoke/go, this file type-checks, so
// go vet reaches its analyzers and prints the `file:line:col: message` shape
// (no `vet: ` prefix) that a type error does not.
func main() {
	fmt.Printf("%d\n", "not a number")
}

package main

import "os"

func main() {
	os.Remove("scratch.tmp")
}

func unused() {}

package redact_test

import (
	"encoding/json"
	"fmt"

	"github.com/jamesainslie/libo11y/go/redact"
)

func ExampleStruct() {
	type Payment struct {
		Card     string `o11y:"mask"`
		CVV      string `o11y:"redact"`
		PIN      string `o11y:"omit"`
		Merchant string
	}
	p := redact.Struct(Payment{Card: "4111", CVV: "123", PIN: "9", Merchant: "acme"})

	fmt.Printf("%v\n", p)
	b, _ := json.Marshal(p)
	fmt.Println(string(b))
	// Output:
	// {Card:XXXX CVV:REDACTED Merchant:acme}
	// {"Card":"XXXX","CVV":"REDACTED","Merchant":"acme"}
}

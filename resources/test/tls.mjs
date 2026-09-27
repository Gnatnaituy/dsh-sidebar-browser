/**
 * A throwaway key pair for the HTTPS fixture target.
 *
 * The suites must exercise an `https://` upstream without reaching the network
 * and without trusting a real certificate — the proxy disables verification for
 * target connections anyway, which is what lets it serve a dev server with a
 * self-signed certificate. This pair is generated for the tests alone, is valid
 * for a century so it never expires out from under them, and must never be used
 * for anything else.
 *
 * Regenerate with:
 *
 *   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem \
 *     -days 36500 -subj "/CN=localhost" \
 *     -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
 */

/** PEM private key of the fixture certificate. */
export const FIXTURE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDLdnIoOm/NaCQ/
mOe4A3NqZg3i4WXdIbkispmcjA2Mm7kfjU14ZzQr/Y4q6jXStBrxIxiT6fxnpss3
xWEgFtMsy0rdPKmZ84kgYKLbyzaQ8hfx8SMLU8Te5Me9BfSDlNKF4IfWVtTIc/sL
Inh828yFbrwHo/4A0FtssHOmDDlDHLIGDKpcBHJ3u5+Cnu1fUEIT6riX4c1HjgWQ
CTNIsVtmXd00nJisqZioV7rF5rM0TFDU22dZX4ENSNVZZTu3lZmCWKFUgrkfNHv4
BumWClfwOxv6vdtsush55nsz9sYD7c5H5yrK9xdE/7GD8ZGlYMmY5XD9q4yS/A4L
EIArsjq7AgMBAAECggEBALfbgvEjTWCamRb3P32jcKpXKnk5IWmgTcIzDmjOjnff
SHxgnf8Nk7Gk4NGa76RFqIr7IfyX1sR7juwI6umqdo3l7vLZHJHH5sRhTwm7KsX0
Xvr84qQbwK2Co5QGS5yT4WGlMlrYAFRbqiG3tpVtsfVpyXRGFwP5RISFNxx3s08W
hKQ82+bcRn9nzagtEPBbiGYshSyOcNw/b2jWjLL47GSvNGpQAUMU3ESDpgO1ULKD
aw+Pn4iEcXFJMtoNoYLO9rSVHImJzyw2R0FCnmRTOV9aLCKiIcCIsSg/7uI2a9d2
W3ogRNv5lxXVuPqkP4i1RlNxFfZQdLgiiSismehHFeECgYEA6KUBEtnqYDQzYOlR
3Dq1CzxQBzHDbrroE5N660A+MkUSfAKbHV0UG8e6JsAsxMAm3gwKo6R3epVyYbgE
zlBumO68OVg70f/8C/VI4mfN0QslUrfkLjjrXtKBTaNSDWYqhgosMrTpkSh8+NwQ
DcL0dPFh5U9MKPK7lvmCbLUbt4MCgYEA3+N2viVYHR+0R5/wB1MDUb1Kz9xa8072
NgH1mKmTkzy4MeyW+vtisKYjX2i19iGvhJBZZGhMmz+jvKlfIeaDzfE3RF0LOGXJ
cOukacKr7Lfjg+L9Eb704iQpVFJmORrwcR+RSQGhX5/XBzB5N0O07jqRDWiTgg4s
UM6qkaGEUmkCgYEAt/vORo9J+L0vqMO8dnODPBh9ncLwMMDlyp2Gx0duKKlRffs9
mtJCldm1UPIINa1Uz6QsQdBOoQZRiBBU1KjtXkrnVl5+KIzOUtKvykWXkmvDH5DI
hvmCwuGtWq3/tRMILCsdWxiR4rdnZhP7Kjb0xwsihYvZykR0sGgwijIMcmsCgYEA
wFDcg/MCIGpGaqwI+9Gj7UfDho+LFKsENVozhAJOQNCMjF3lRww/NuxPQDpq61T+
Nsnj76rj+wuMc5etnyoql/GW/sNJyxUsFzJjFXHiSsGezoBh0CeOpN5ZHhR1uKHa
XeG249ZhrwlXJNbPmNgxB94JEVJ+Ot4/1N3hiJ0MU9kCgYAvcJc1hlqGpV9EXkPA
ogKdLAbaXireZu1V0XzO+ZJC3K5iHDj8fZc1sGZ7yCIoLDvg891b+f/IPPnGwve0
FxMNDGSXbuQJDR6JhvzeFn3W+uK5ZpYCfUMocK9XWEz26vkvrb42uuxpLi3YJJ8r
tWW8Nl4WSlJtDtIqBJBALBQuzw==
-----END PRIVATE KEY-----
`

/** PEM certificate matching FIXTURE_KEY. */
export const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIICyzCCAbOgAwIBAgIJAOG8Uc1kax59MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDAgFw0yNjA5MjYxNjUwMzdaGA8yMTI2MDkwMjE2NTAzN1ow
FDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB
CgKCAQEAy3ZyKDpvzWgkP5jnuANzamYN4uFl3SG5IrKZnIwNjJu5H41NeGc0K/2O
Kuo10rQa8SMYk+n8Z6bLN8VhIBbTLMtK3TypmfOJIGCi28s2kPIX8fEjC1PE3uTH
vQX0g5TSheCH1lbUyHP7CyJ4fNvMhW68B6P+ANBbbLBzpgw5QxyyBgyqXARyd7uf
gp7tX1BCE+q4l+HNR44FkAkzSLFbZl3dNJyYrKmYqFe6xeazNExQ1NtnWV+BDUjV
WWU7t5WZglihVIK5HzR7+AbplgpX8Dsb+r3bbLrIeeZ7M/bGA+3OR+cqyvcXRP+x
g/GRpWDJmOVw/auMkvwOCxCAK7I6uwIDAQABox4wHDAaBgNVHREEEzARgglsb2Nh
bGhvc3SHBH8AAAEwDQYJKoZIhvcNAQELBQADggEBALoaA+62P/8vFOWyl9muastV
of1F+PLbbaVMfszItLj4rM1D2gKUH76PXfIeicpu5mgdaZnv2Fg7+mLK2dsJm28p
37fCLcCDcUQAPgad3kCmVdFknuelf0Go1KoH/j6CjkIRF0sxrSkpV9fSngO5NIrg
Z25NO84nNE2wu9w/8HV8ASFPHmSDoA34YFilDGpVUnPFn3g/52nd1WycopcjSE0y
64cz0XViM0mAmx7D3XqRkeyxEo9Klx0MI9ECPHJ+pFFxoCS+r/nevUI1Bo3lcKge
aK8rsquJPRYJX4dpTEQ90sqtSCVX0PD6OtnguuU0Nm8sXMA8azHHBZM+xvIxB3I=
-----END CERTIFICATE-----
`

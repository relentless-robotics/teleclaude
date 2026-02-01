# Open Gmail in default browser with search for Gumroad email
$gmailSearchUrl = "https://mail.google.com/mail/u/0/#search/from%3Agumroad+%22Confirmation+instructions%22"
Start-Process $gmailSearchUrl
Write-Host "Opened Gmail in default browser. Please click the verification link in the Gumroad email."

#!/usr/bin/env perl
# Strip CRLF from staged text files. Called from lefthook pre-commit.
# If a file has unstaged changes, bail instead of silently widening the commit.
use strict;
use warnings;

my $rc = 0;
for my $f (@ARGV) {
    open(my $fh, '<:raw', $f) or do { warn "open $f: $!\n"; $rc = 1; next };
    local $/;
    my $c = <$fh>;
    close $fh;
    next unless defined $c && $c =~ /\r/;

    if (system('git', 'diff', '--quiet', '--', $f) != 0) {
        warn "CRLF in $f but it has unstaged changes - fix manually\n";
        $rc = 1;
        next;
    }

    $c =~ s/\r\n?/\n/g;
    open($fh, '>:raw', $f) or do { warn "write $f: $!\n"; $rc = 1; next };
    print $fh $c;
    close $fh;
    print "fixed CRLF: $f\n";
}
exit $rc;

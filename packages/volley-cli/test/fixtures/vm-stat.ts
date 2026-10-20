/**
 * `vm_stat` on a 16 GB Apple-silicon Mac in normal use (16 KB pages, 1048576 pages in all): few
 * free pages, most of the rest inactive or reclaimable. Free pages alone read 3%; the available
 * figure (free + inactive + speculative + purgeable) reads 45%.
 */
export const VM_STAT_MAC_16GB = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               31457.
Pages active:                            380000.
Pages inactive:                          361000.
Pages speculative:                        44000.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                          35420.
"Translation faults":                 912345678.
Pages copy-on-write:                   23456789.
Pages zero filled:                    345678901.
Pages reactivated:                      1234567.
Pages purged:                            234567.
File-backed pages:                       300000.
Anonymous pages:                         485000.
Pages stored in compressor:              120000.
Pages occupied by compressor:             40000.
Decompressions:                         2345678.
Compressions:                           3456789.
Pageins:                                4567890.
Pageouts:                                 12345.
Swapins:                                      0.
Swapouts:                                     0.
`;

export const MAC_16GB_BYTES = 16 * 1024 ** 3;

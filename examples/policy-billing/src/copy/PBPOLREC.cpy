      * Policy master record (VSAM KSDS, keyed on policy number).
       01  POLICY-REC.
           05  POL-NUMBER          PIC X(10).
           05  POL-STATUS          PIC X.
               88  POL-ACTIVE      VALUE 'A'.
               88  POL-LAPSED      VALUE 'L'.
           05  POL-PRODUCT         PIC X(4).
           05  POL-ISSUE-AGE       PIC 9(3).
           05  POL-FACE-AMOUNT     PIC S9(9)V99 COMP-3.
           05  POL-RATE-CLASS      PIC X(2).
           05  FILLER              PIC X(52).

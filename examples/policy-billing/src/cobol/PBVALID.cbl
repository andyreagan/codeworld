       IDENTIFICATION DIVISION.
       PROGRAM-ID. PBVALID.
      * Validates one premium transaction against its policy: the
      * policy must be in force and the amount must make sense for
      * the transaction type.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-MAX-AMOUNT           PIC S9(7)V99 VALUE 250000.00.
       LINKAGE SECTION.
           COPY PBTXNREC.
           COPY PBPOLREC.
       01  LS-VALID                PIC X.
       PROCEDURE DIVISION USING TXN-REC POLICY-REC LS-VALID.
       0000-MAIN.
           MOVE 'Y' TO LS-VALID
           PERFORM 1000-CHECK-POLICY
           IF LS-VALID = 'Y'
               PERFORM 2000-CHECK-AMOUNT
           END-IF
           GOBACK.
       1000-CHECK-POLICY.
           IF NOT POL-ACTIVE AND NOT TXN-NEW-BUSINESS
               MOVE 'N' TO LS-VALID
           END-IF.
       2000-CHECK-AMOUNT.
           EVALUATE TRUE
               WHEN TXN-AMOUNT <= 0
                   MOVE 'N' TO LS-VALID
               WHEN TXN-AMOUNT > WS-MAX-AMOUNT
                   MOVE 'N' TO LS-VALID
               WHEN TXN-ENDORSEMENT AND TXN-AMOUNT > 10000
                   MOVE 'N' TO LS-VALID
           END-EVALUATE.
